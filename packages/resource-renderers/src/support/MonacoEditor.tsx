import { useT } from "@thinkrail/locales/react";
import type { editor } from "monaco-editor/esm/vs/editor/editor.api.js";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { type ResourceHost, useResourceHost, useResourcePreferences } from "../host";
import type { ResourceDescriptor, ResourceViewProps, SurfaceReview } from "../registry";
import { MonacoReviewZones } from "./MonacoReviewZones";
import { decorateEditorContextMenus } from "./monacoMenuIcons";
import {
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

export default function MonacoEditor({
	resource,
	content,
	review,
	viewState,
	onViewState,
}: ResourceViewProps) {
	const t = useT();
	const { fileLineWidth, fileLineWidthBounded } = useResourcePreferences();
	ensureMonaco(useResourceHost().code);
	const modelPath = `${useId().replace(/[^\w-]/g, "")}/${resource.path}`;
	const language = languageForPath(resource.path);
	const text = content.kind === "text" ? content.text : "";
	const commentLabel = t("review.widget.commentOnSelection");
	const options = fileEditorOptions(t, fileLineWidth, fileLineWidthBounded, resource.path);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const commentingRef = useRef<ReviewCommenting | null>(null);
	const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
	const threadsRef = useRef<ReturnType<typeof attachReviewThreads> | null>(null);
	const decorationsRef = useRef<string[]>([]);
	const appliedTextRef = useRef(text);
	const appliedOptionsRef = useRef(options);
	const latestRef = useRef({
		modelPath,
		language,
		text,
		options,
		commentLabel,
		viewState,
		review,
		onViewState,
	});
	const [reviewZones, setReviewZones] = useState<MonacoReviewZoneState>({
		threads: [],
		composer: null,
	});

	useLayoutEffect(() => {
		latestRef.current = {
			modelPath,
			language,
			text,
			options,
			commentLabel,
			viewState,
			review,
			onViewState,
		};
	});

	useLayoutEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const mount = latestRef.current;
		const codeEditor = createFileEditor(container, mount);
		editorRef.current = codeEditor;
		appliedTextRef.current = mount.text;
		appliedOptionsRef.current = mount.options;
		const menuIcons = decorateEditorContextMenus(codeEditor);
		if (isEditorViewState(mount.viewState)) codeEditor.restoreViewState(mount.viewState);
		const threads = mount.review ? attachReviewThreads(codeEditor, setReviewZones) : null;
		const commenting = threads
			? attachReviewCommenting(codeEditor, threads, mount.commentLabel)
			: null;
		threadsRef.current = threads;
		commentingRef.current = commenting;
		return () => {
			const saved = codeEditor.saveViewState();
			if (saved) latestRef.current.onViewState?.(saved);
			menuIcons.dispose();
			commenting?.dispose();
			threads?.dispose();
			threadsRef.current = null;
			commentingRef.current = null;
			editorRef.current = null;
			decorationsRef.current = [];
			disposeFileEditor(codeEditor);
		};
	}, []);

	useLayoutEffect(() => {
		const codeEditor = editorRef.current;
		if (!codeEditor) return;
		syncFileModel(codeEditor, { modelPath, language, text }, appliedTextRef.current);
		appliedTextRef.current = text;
	}, [modelPath, language, text]);

	useLayoutEffect(() => {
		commentingRef.current?.setLabel(commentLabel);
	}, [commentLabel]);

	useLayoutEffect(() => {
		if (options === appliedOptionsRef.current) return;
		appliedOptionsRef.current = options;
		editorRef.current?.updateOptions(options);
	}, [options]);

	const closeComposer = () => threadsRef.current?.closeComposer();
	const layoutReviewZones = () => threadsRef.current?.layout();

	useLayoutEffect(() => {
		const codeEditor = editorRef.current;
		if (!review || !codeEditor) return;
		threadsRef.current?.setThreads(review.threads);
		decorationsRef.current = applyReviewDecorations(
			codeEditor,
			decorationsRef.current,
			review.threads,
		);
	}, [review]);

	useLayoutEffect(() => {
		if (!review || !editorRef.current) return;
		const line = focusLine(review);
		if (line === null) return;
		revealLineNow(editorRef.current, line);
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
