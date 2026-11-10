import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { HtmlFrame } from "./HtmlFrame";
import {
	followHeight,
	frameIndependentHeight,
	restartHeightFollow,
	UNMEASURED_HEIGHT,
} from "./heightFollow";
import { hostThemeSnapshot, serverThemeSnapshot, subscribeHostTheme } from "./hostTheme";
import { buildThemedHtmlDocument, THEME_STYLE_ATTRIBUTE } from "./htmlDocument";
import { HTML_CONTENT_HEIGHT, type HtmlViewport } from "./viewport";

const THEME_STYLE = `style[${THEME_STYLE_ATTRIBUTE}]`;

function themedRoot(frame: HTMLIFrameElement | null): HTMLElement | null {
	const document = frame?.contentDocument;
	if (!document) return null;
	const root: HTMLElement | null = Reflect.get(Document.prototype, "documentElement", document);
	return root?.querySelector(THEME_STYLE) ? root : null;
}

function hideVerticalScrollbar(root: HTMLElement, hidden: boolean): void {
	if (hidden) root.style.setProperty("overflow-y", "hidden", "important");
	else root.style.removeProperty("overflow-y");
}

function measuredHeight(frame: HTMLIFrameElement, root: HTMLElement): number | null {
	const { scrollTop } = root;
	const hidden = root.style.getPropertyValue("overflow-y") === "hidden";
	hideVerticalScrollbar(root, true);
	try {
		return frameIndependentHeight((frameHeight) => {
			frame.style.height = `${frameHeight}px`;
			const scrollbar = Math.max(0, frame.clientHeight - root.clientHeight);
			return {
				flow: Math.ceil(root.getBoundingClientRect().height) + scrollbar,
				extent: root.scrollHeight + scrollbar,
			};
		});
	} finally {
		frame.style.height = "";
		hideVerticalScrollbar(root, hidden);
		root.scrollTo({ top: scrollTop, behavior: "instant" });
	}
}

export function ThemedHtmlFrame({
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
	const [built, setBuilt] = useState(() => ({
		source,
		html: buildThemedHtmlDocument(source, theme),
	}));
	let current = built;
	if (built.source !== source) {
		current = { source, html: buildThemedHtmlDocument(source, theme) };
		setBuilt(current);
	}
	const frameRef = useRef<HTMLIFrameElement>(null);
	const [loads, setLoads] = useState(0);
	const follow = useRef(UNMEASURED_HEIGHT);
	const holdsDocument = contentHeight !== undefined && contentHeight <= HTML_CONTENT_HEIGHT.max;

	useEffect(() => {
		const style = loads > 0 ? themedRoot(frameRef.current)?.querySelector(THEME_STYLE) : null;
		if (style && style.textContent !== theme) style.textContent = theme;
	}, [loads, theme]);

	useEffect(() => {
		const root = loads > 0 ? themedRoot(frameRef.current) : null;
		if (root) hideVerticalScrollbar(root, holdsDocument);
	}, [loads, holdsDocument]);

	useEffect(() => {
		const frame = frameRef.current;
		const root = loads > 0 ? themedRoot(frame) : null;
		if (!frame || !root || !onContentHeight) return;
		follow.current = restartHeightFollow(follow.current);
		const report = () => {
			const previous = follow.current;
			if (previous.stopped || themedRoot(frame) !== root) return;
			const next = followHeight(previous, {
				height: measuredHeight(frame, root),
				width: frame.clientWidth,
				at: performance.now(),
			});
			follow.current = next;
			if (next.height !== previous.height) onContentHeight(next.height);
		};
		const observer = new ResizeObserver(report);
		observer.observe(root);
		report();
		return () => observer.disconnect();
	}, [loads, onContentHeight]);

	return (
		<HtmlFrame
			title={title}
			document={current.html}
			viewport={viewport}
			sandbox="allow-same-origin"
			frameRef={frameRef}
			onLoad={() => setLoads((count) => count + 1)}
			{...(contentHeight === undefined ? {} : { contentHeight })}
		/>
	);
}
