import { useT } from "@thinkrail/locales/react";
import type { editor } from "monaco-editor/editor/editor.api.js";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { type ResourceHost, useResourceHost, useResourcePreferences } from "../host";
import type { ResourceDescriptor, ResourceViewProps, SurfaceReview } from "../registry";
import { MonacoReviewZones } from "./MonacoReviewZones";
import { decorateEditorContextMenus } from "./monacoMenuIcons";
import {
	bindEditSession,
	createFileEditor,
	disposeFileEditor,
	ensureMonaco,
	fileEditorOptions,
	languageForPath,
	revealLineNow,
	syncFileModel,
	warmLanguage,
} from "./monacoSetup";
import {
	applyReviewDecorations,
	attachReviewCommenting,
	attachReviewThreads,
	type MonacoReviewZoneState,
	type ReviewCommenting,
} from "./reviewWidgets";

function focusLine(review: SurfaceReview): number | null {
	const range = review.focus?.anchor.selectors.find((selector) => selector.kind === "lineRange");
	return range?.kind === "lineRange" ? range.startLine : null;
}

function isEditorViewState(value: unknown): value is editor.ICodeEditorViewState {
	if (typeof value !== "object" || value === null) return false;
	return Array.isArray(Reflect.get(value, "cursorState")) && Reflect.has(value, "viewState");
}

export function warm(host: ResourceHost, resource: ResourceDescriptor): void {
	ensureMonaco(host.code);
	setTimeout(() => warmLanguage(languageForPath(resource.path)), 0);
}

const NO_REVIEW_ZONES: MonacoReviewZoneState = { threads: [], composer: null };

export default function MonacoEditor({
	resource,
	content,
	edit,
	review,
	viewState,
	onViewState,
}: ResourceViewProps) {
	const t = useT();
	const { fileLineWidth, fileLineWidthBounded } = useResourcePreferences();
	ensureMonaco(useResourceHost().code);
	const scope = useId().replace(/[^\w-]/g, "");
	const path = resource.path;
	const text = content.kind === "text" ? content.text : "";
	const commentLabel = t("review.widget.commentOnSelection");
	const editable = edit !== undefined;
	const options = fileEditorOptions(
		t,
		fileLineWidth,
		fileLineWidthBounded,
		resource.path,
		editable,
	);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const commentingRef = useRef<ReviewCommenting | null>(null);
	const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
	const threadsRef = useRef<ReturnType<typeof attachReviewThreads> | null>(null);
	const decorationsRef = useRef<string[]>([]);
	const freshMountRef = useRef(false);
	const appliedRef = useRef<{
		scope: typeof scope;
		path: string;
		text: string | null;
		options: typeof options;
	}>({ scope, path, text, options });
	const latestRef = useRef({
		scope,
		path,
		text,
		edit,
		options,
		commentLabel,
		viewState,
		onViewState,
	});
	const [reviewZones, setReviewZones] = useState<MonacoReviewZoneState>(NO_REVIEW_ZONES);
	const hasReview = review !== undefined;

	const detachReview = () => {
		const codeEditor = editorRef.current;
		const threads = threadsRef.current;
		if (!codeEditor || !threads) return;
		commentingRef.current?.dispose();
		threads.dispose();
		threadsRef.current = null;
		commentingRef.current = null;
		decorationsRef.current = codeEditor.deltaDecorations(decorationsRef.current, []);
		setReviewZones(NO_REVIEW_ZONES);
	};

	useLayoutEffect(() => {
		latestRef.current = {
			scope,
			path,
			text,
			edit,
			options,
			commentLabel,
			viewState,
			onViewState,
		};
	});

	useLayoutEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const mount = latestRef.current;
		const codeEditor = createFileEditor(container, {
			...mount,
			text: mount.edit ? mount.edit.snapshot() : mount.text,
		});
		editorRef.current = codeEditor;
		freshMountRef.current = true;
		appliedRef.current = {
			scope: mount.scope,
			path: mount.path,
			text: mount.text,
			options: mount.options,
		};
		const menuIcons = decorateEditorContextMenus(codeEditor);
		if (isEditorViewState(mount.viewState)) codeEditor.restoreViewState(mount.viewState);
		return () => {
			const saved = codeEditor.saveViewState();
			if (saved) latestRef.current.onViewState?.(saved);
			menuIcons.dispose();
			detachReview();
			editorRef.current = null;
			disposeFileEditor(codeEditor);
		};
	}, []);

	useLayoutEffect(() => {
		const codeEditor = editorRef.current;
		if (!codeEditor || !hasReview) return;
		const threads = attachReviewThreads(codeEditor, setReviewZones);
		threadsRef.current = threads;
		commentingRef.current = attachReviewCommenting(
			codeEditor,
			threads,
			latestRef.current.commentLabel,
		);
		return detachReview;
	}, [hasReview]);

	useLayoutEffect(() => {
		const codeEditor = editorRef.current;
		const applied = appliedRef.current;
		if (
			!codeEditor ||
			edit ||
			(applied.scope === scope && applied.path === path && applied.text === text)
		) {
			return;
		}
		syncFileModel(codeEditor, { scope, path, text }, applied.text);
		appliedRef.current = { ...applied, scope, path, text };
	}, [scope, path, text, edit]);

	useLayoutEffect(() => {
		const codeEditor = editorRef.current;
		if (!codeEditor || !edit) return;
		const binding = bindEditSession(codeEditor, { scope, path, session: edit });
		return () => {
			binding.dispose();
			appliedRef.current = { ...appliedRef.current, text: null };
		};
	}, [scope, path, edit]);

	useLayoutEffect(() => {
		commentingRef.current?.setLabel(commentLabel);
	}, [commentLabel]);

	useLayoutEffect(() => {
		const codeEditor = editorRef.current;
		if (!codeEditor || appliedRef.current.options === options) return;
		appliedRef.current = { ...appliedRef.current, options };
		codeEditor.updateOptions(options);
	}, [options]);

	const closeComposer = () => threadsRef.current?.closeComposer();
	const layoutReviewZones = () => threadsRef.current?.layout();

	useLayoutEffect(() => {
		const codeEditor = editorRef.current;
		const freshMount = freshMountRef.current;
		freshMountRef.current = false;
		if (!review || !codeEditor) return;
		threadsRef.current?.setThreads(review.threads);
		decorationsRef.current = applyReviewDecorations(
			codeEditor,
			decorationsRef.current,
			review.threads,
		);
		const line = focusLine(review);
		if (line === null) return;
		if (freshMount) revealLineNow(codeEditor, line);
		else codeEditor.revealLineInCenter(line);
		review.onFocusHandled();
	}, [review]);

	return (
		<>
			<div ref={containerRef} className="h-full w-full text-left" />
			<MonacoReviewZones
				zones={reviewZones}
				review={review}
				onCloseComposer={closeComposer}
				onRendered={layoutReviewZones}
			/>
		</>
	);
}
