import { standardKeymap } from "@codemirror/commands";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { useT } from "@thinkrail/locales/react";
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useResourceHost } from "../host";
import type { ConflictChoice, ResourceEditSession, ResourceViewProps } from "../registry";
import { ConflictLens, ConflictTheirs } from "./conflictLens";
import { LiveFindBar } from "./LiveFindBar";
import {
	bindSession,
	continueList,
	createPortalHost,
	linkHrefAt,
	linkTarget,
	liveFind,
	livePresence,
	livePresenceSurface,
	livePreview,
	liveText,
	markdownLanguage,
	newlineKeepingIndent,
	type PortalEntry,
	portalHost,
	type SessionBinding,
	setConflicts,
	setThreads,
	type ThreadAnchor,
} from "./livePreview";
import { MarkdownDocument } from "./MarkdownPreview";
import { createPresenceMarks } from "./presenceCore";
import { presenceKindIcon } from "./presenceIcons";
import { usePresenceText } from "./presenceText";
import { ReviewThreadCard } from "./ReviewThreadCard";
import { useScrollViewState } from "./useScrollViewState";

const textCompartment = new Compartment();

function liveTextOf(t: ReturnType<typeof useT>) {
	return liveText.of({
		task: t("viewer.markdown.task"),
		followLink: t("viewer.markdown.followLink"),
	});
}

type LiveProps = Omit<ResourceViewProps, "content" | "edit"> & { edit: ResourceEditSession };

function threadAnchors(review: ResourceViewProps["review"]): ThreadAnchor[] {
	return (review?.threads ?? []).flatMap((thread) => {
		const range = thread.anchor.selectors.find((selector) => selector.kind === "lineRange");
		return range?.kind === "lineRange" ? [{ id: thread.id, line: range.endLine }] : [];
	});
}

function enter(view: EditorView) {
	view.dispatch(continueList(view.state) ?? newlineKeepingIndent(view.state));
	return true;
}

function LivePortal({
	entry,
	props,
	view,
	onResolve,
}: {
	entry: PortalEntry;
	props: LiveProps;
	view: EditorView | null;
	onResolve(id: number, choice: ConflictChoice): void;
}) {
	const t = useT();
	const { markdown, bytesUrl, openFile } = useResourceHost();
	const links = useMemo(() => ({ bytesUrl, openFile }), [bytesUrl, openFile]);
	const { content } = entry;
	switch (content.kind) {
		case "block":
			return content.block.kind === "frontmatter" ? (
				<div className="tr-text-metadata text-text-subtle">
					{t("viewer.markdown.frontmatter", { count: content.block.source.split("\n").length })}
				</div>
			) : (
				<MarkdownDocument
					content={content.block.source}
					workspaceId={props.resource.workspaceId}
					path={props.resource.path}
					Markdown={markdown}
					links={links}
				/>
			);
		case "thread": {
			const thread = props.review?.threads.find((candidate) => candidate.id === content.id);
			return thread && props.review ? (
				<ReviewThreadCard thread={thread} actions={props.review.actions} />
			) : null;
		}
		case "lens":
			return <ConflictLens conflict={content.conflict} focusable onResolve={onResolve} />;
		case "theirs":
			return <ConflictTheirs conflict={content.conflict} theirsText={content.theirsText} />;
		case "find":
			return view ? <LiveFindBar view={view} /> : null;
	}
}

export default function LiveMarkdownEditor(props: LiveProps) {
	const { resource, edit, review, presence, viewState, onViewState } = props;
	const t = useT();
	const { openFile } = useResourceHost();
	const presenceText = usePresenceText();
	const hostRef = useRef<HTMLDivElement>(null);
	const chipRef = useRef<HTMLDivElement>(null);
	const [view, setView] = useState<EditorView | null>(null);
	const presenceRef = useRef<ReturnType<typeof createPresenceMarks> | null>(null);
	const [announcement, setAnnouncement] = useState({ seq: 0, text: "" });
	const [portals] = useState(createPortalHost);
	const entries = useSyncExternalStore(portals.subscribe, portals.snapshot);
	const { attach: attachScroller } = useScrollViewState<HTMLDivElement>(viewState, onViewState);
	const latestRef = useRef({ presenceText, presence, openFile });
	useLayoutEffect(() => {
		latestRef.current = { presenceText, presence, openFile };
	});

	const { workspaceId, path } = resource;
	useLayoutEffect(() => {
		const parent = hostRef.current;
		const chipHost = chipRef.current;
		if (!parent || !chipHost) return;
		let binding: SessionBinding | null = null;
		const follow = (href: string, view: EditorView) => {
			const target = linkTarget(view.state, path, href);
			if (target?.kind === "line") {
				const at = view.state.doc.line(target.line).from;
				view.dispatch({
					selection: { anchor: at },
					effects: EditorView.scrollIntoView(at, { y: "start" }),
				});
				view.focus();
			} else if (target?.kind === "file") latestRef.current.openFile(workspaceId, target.path);
			else if (target?.kind === "external")
				window.open(target.href, "_blank", "noopener,noreferrer");
		};
		const history = (run: (binding: SessionBinding) => void) => () => {
			if (binding) run(binding);
			return true;
		};
		const view = new EditorView({
			parent,
			state: EditorState.create({
				doc: edit.snapshot(),
				extensions: [
					markdownLanguage,
					livePreview,
					livePresence,
					liveFind,
					portalHost.of(portals),
					textCompartment.of([]),
					EditorView.lineWrapping,
					EditorView.editorAttributes.of({ class: "md-live" }),
					EditorView.contentAttributes.of({
						class: "tr-prose-doc text-text-default",
						"aria-label": path,
					}),
					Prec.highest(
						keymap.of([
							{ key: "Mod-z", run: history((bound) => bound.undo()), preventDefault: true },
							{ key: "Mod-Shift-z", run: history((bound) => bound.redo()), preventDefault: true },
							{ key: "Mod-y", run: history((bound) => bound.redo()), preventDefault: true },
							{
								key: "Mod-Enter",
								run: (target) => {
									const href = linkHrefAt(target.state, target.state.selection.main.head);
									if (href === null) return false;
									follow(href, target);
									return true;
								},
							},
							{ key: "Enter", run: enter, shift: enter },
						]),
					),
					keymap.of(standardKeymap),
					EditorView.domEventHandlers({
						compositionstart: () => {
							binding?.compositionStart();
							return false;
						},
						compositionend: () => {
							binding?.compositionEnd();
							return false;
						},
						beforeinput: (event) => {
							if (event.inputType !== "historyUndo" && event.inputType !== "historyRedo") {
								return false;
							}
							event.preventDefault();
							if (event.inputType === "historyUndo") binding?.undo();
							else binding?.redo();
							return true;
						},
						mousedown: (event, target) => {
							if (!event.metaKey && !event.ctrlKey) return false;
							const link =
								event.target instanceof Element ? event.target.closest("[data-href]") : null;
							const href = link?.getAttribute("data-href");
							if (!href) return false;
							event.preventDefault();
							follow(href, target);
							return true;
						},
					}),
				],
			}),
			dispatchTransactions: (transactions, target) => {
				if (binding) binding.dispatch(transactions);
				else target.update(transactions);
			},
		});
		portals.onResize(() => view.requestMeasure());
		const marks = createPresenceMarks(livePresenceSurface(view, chipHost), {
			text: () => latestRef.current.presenceText,
			announce: (text) => setAnnouncement((previous) => ({ seq: previous.seq + 1, text })),
			icon: presenceKindIcon,
		});
		marks.setLatest(latestRef.current.presence?.latest);
		presenceRef.current = marks;
		binding = bindSession(view, edit, {
			onConflicts: (conflicts) => view.dispatch({ effects: setConflicts.of(conflicts) }),
			onDisk: marks.land,
		});
		setView(view);
		return () => {
			binding?.dispose();
			binding = null;
			marks.dispose();
			presenceRef.current = null;
			setView(null);
			portals.onResize(() => {});
			view.destroy();
		};
	}, [edit, portals, path, workspaceId]);

	useLayoutEffect(() => {
		presenceRef.current?.setLatest(presence?.latest);
	}, [presence]);

	useLayoutEffect(() => {
		view?.dispatch({ effects: textCompartment.reconfigure(liveTextOf(t)) });
	}, [t, view]);

	useLayoutEffect(() => {
		if (!view) return;
		view.dispatch({ effects: setThreads.of(threadAnchors(review)) });
		const focus = review?.focus;
		if (!focus) return;
		const range = focus.anchor.selectors.find((selector) => selector.kind === "lineRange");
		if (range?.kind === "lineRange") {
			const line = view.state.doc.line(Math.min(Math.max(range.endLine, 1), view.state.doc.lines));
			view.dispatch({ effects: EditorView.scrollIntoView(line.to, { y: "center" }) });
		}
		review.onFocusHandled();
	}, [review, view]);

	const resolve = (id: number, choice: ConflictChoice) => {
		edit.resolveConflict(id, choice);
		view?.focus();
	};

	return (
		<div className="relative h-full">
			<div
				ref={attachScroller}
				data-testid="markdown-preview"
				data-mode="live"
				className="h-full overflow-auto bg-container-workspace-bg ring-control-border-active ring-inset has-[.cm-focused]:ring-1"
			>
				<article className="mx-auto max-w-[78ch] py-16 pr-24">
					<div ref={hostRef} />
				</article>
			</div>
			<div ref={chipRef} className="pointer-events-none absolute top-40 right-12 z-10" />
			<span role="status" aria-live="polite" className="sr-only">
				<span key={announcement.seq}>{announcement.text}</span>
			</span>
			{entries.map((entry) =>
				createPortal(
					<LivePortal entry={entry} props={props} view={view} onResolve={resolve} />,
					entry.node,
					String(entry.key),
				),
			)}
		</div>
	);
}
