import { useT } from "@thinkrail/locales/react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { acceptFrameMessage, themeMessage } from "./frameMessages";
import { createFrameWatch, frameSender } from "./frameWatch";
import { HtmlFrame } from "./HtmlFrame";
import { hostThemeSnapshot, serverThemeSnapshot, subscribeHostTheme } from "./hostTheme";
import { buildScriptedHtmlDocument } from "./scriptedDocument";
import { createScriptedHeight } from "./scriptedHeight";
import type { HtmlViewport } from "./viewport";

interface Built {
	source: string;
	html: string;
	stopped: boolean;
	heldFocus: boolean;
}

function stopped(html: string, heldFocus: boolean) {
	return (now: Built): Built => (now.html === html ? { ...now, stopped: true, heldFocus } : now);
}

function focusOnMount(node: HTMLElement | null) {
	node?.focus({ preventScroll: true });
}

export function MockupStoppedNotice({ focus }: { focus: boolean }) {
	const t = useT();
	return (
		<p
			role="status"
			data-testid="html-mockup-stopped"
			className="m-0 px-12 py-16 tr-text-metadata text-feedback-warning"
			{...(focus ? { tabIndex: -1, ref: focusOnMount } : {})}
		>
			{t("viewer.html.mockupStopped")}
		</p>
	);
}

export function ScriptedHtmlFrame({
	title,
	source,
	viewport,
	contentHeight,
	onContentHeight,
}: {
	title: string;
	source: string;
	viewport: HtmlViewport;
	contentHeight?: number;
	onContentHeight?: (height: number | null) => void;
}) {
	const theme = useSyncExternalStore(subscribeHostTheme, hostThemeSnapshot, serverThemeSnapshot);
	const [built, setBuilt] = useState<Built>(() => ({
		source,
		html: buildScriptedHtmlDocument(source, theme),
		stopped: false,
		heldFocus: false,
	}));
	let current = built;
	if (built.source !== source) {
		current = {
			source,
			html: buildScriptedHtmlDocument(source, theme),
			stopped: false,
			heldFocus: false,
		};
		setBuilt(current);
	}
	const { html } = current;
	const frameRef = useRef<HTMLIFrameElement>(null);
	const [watch] = useState(createFrameWatch);
	const [heights] = useState(() =>
		createScriptedHeight({
			height: contentHeight ?? null,
			remeasure: (frame) =>
				frame.contentWindow?.postMessage(themeMessage(hostThemeSnapshot(), watch.seq()), "*"),
		}),
	);

	const onLoad = () => {
		const seq = watch.load(() =>
			setBuilt(stopped(html, document.activeElement === frameRef.current)),
		);
		heights.restart();
		frameRef.current?.contentWindow?.postMessage(themeMessage(theme, seq), "*");
	};

	useEffect(
		() => () => {
			watch.stop();
			heights.stop();
		},
		[watch, heights],
	);

	useEffect(() => {
		frameRef.current?.contentWindow?.postMessage(themeMessage(theme), "*");
	}, [theme]);

	useEffect(() => {
		const onVisible = () => {
			if (document.visibilityState === "visible") heights.resume();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, [heights]);

	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			const frame = frameRef.current;
			const frameWindow = frame?.contentWindow;
			if (!frame || !frameWindow) return;
			const verdict = watch.receive(performance.now(), frameSender(event, frameWindow));
			if (verdict === "flood") {
				const heldFocus = document.activeElement === frame;
				flushSync(() => setBuilt(stopped(html, heldFocus)));
			}
			if (verdict !== "accept") return;
			const message = acceptFrameMessage(event, { window: frameWindow, seq: watch.seq() });
			if (message?.kind === "ready") watch.ready();
			else if (message?.kind === "height" && onContentHeight) {
				heights.accept(frame, message.report, onContentHeight);
			}
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [watch, heights, onContentHeight, html]);

	if (current.stopped) return <MockupStoppedNotice focus={current.heldFocus} />;

	return (
		<HtmlFrame
			title={title}
			document={html}
			viewport={viewport}
			sandbox="allow-scripts"
			frameRef={frameRef}
			onLoad={onLoad}
			{...(contentHeight === undefined ? {} : { contentHeight })}
		/>
	);
}
