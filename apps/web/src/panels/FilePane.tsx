import { useT } from "@thinkrail/locales/react";
import {
	describeResource,
	focusRendererEditor,
	PENDING_TEXT_META,
	RendererToggles,
	RendererView,
	rendererImplementationKey,
	resourceContent,
	UnplacedReviewStrip,
	useRendererSelection,
} from "@thinkrail/resource-renderers";
import { LoadingRegion } from "@thinkrail/ui/skeleton";
import { Suspense, useEffect, useMemo, useRef } from "react";
import { canEditFile, useFileBuffer, useFileBufferText } from "../editing";
import { isPhoneViewport } from "../lib";
import type { FileTab } from "../store";
import { selectFileBufferSummary, useAppStore } from "../store";
import { getTransport } from "../transport";
import { FileEditBanner } from "./FileEditBanner";
import { resourceBytesUrl, useResetViewStateOnImplementationChange } from "./resourcePane";
import { reviewFlagFor } from "./reviewModel";
import { SendReviewButton } from "./SendReviewButton";
import { useLiveTabContent } from "./useLiveTabContent";
import { useFileReview } from "./useReviewCommenting";

const loading = <LoadingRegion rows={12} className="h-full p-12" testId="file-pane-loading" />;

export function FilePane({ tab }: { tab: FileTab }) {
	const t = useT();
	const setTabRenderer = useAppStore((state) => state.setTabRenderer);
	const review = useFileReview(tab.workspaceId, tab.path, "inline");
	const reviewComments = useAppStore(
		(state) => state.reviewsByWorkspace[tab.workspaceId]?.comments,
	);
	const fileHasDraft = useMemo(
		() => reviewFlagFor(reviewComments, tab.path) === "draft",
		[reviewComments, tab.path],
	);

	const resource = useMemo(
		() => describeResource(tab.workspaceId, tab.path, tab.meta ?? PENDING_TEXT_META),
		[tab.workspaceId, tab.path, tab.meta],
	);
	const { mobile, candidates, renderer, implementationKey, placedThreadIds, onPlacedThreadIds } =
		useRendererSelection(resource, "view", tab.rendererId);
	useResetViewStateOnImplementationChange(tab.workspaceId, tab.id, implementationKey);

	const protocolVersion = useAppStore((state) => state.protocolVersion);
	const editTarget = { mobile, renderer, meta: tab.meta, protocolVersion };
	const buffer = useFileBuffer(tab, canEditFile({ ...editTarget, buffered: false }));
	const editing = buffer !== null && canEditFile({ ...editTarget, buffered: true });
	const bufferText = useFileBufferText(buffer, !editing);
	const summary = useAppStore((state) => selectFileBufferSummary(state, tab.workspaceId, tab.path));
	const isPreview = useAppStore((state) => state.previewTabByWorkspace[tab.workspaceId] === tab.id);
	const dirty = summary?.dirty === true;
	useEffect(() => {
		if (dirty && isPreview) useAppStore.getState().setActiveTab(tab.id, "keep");
	}, [dirty, isPreview, tab.id]);

	useLiveTabContent(tab, {
		read: () => {
			const token = buffer?.readToken() ?? 0;
			return getTransport()
				.request("fs.readFile", { workspaceId: tab.workspaceId, path: tab.path })
				.then(
					(file) => ({ file, token }),
					(error: unknown) => {
						buffer?.readFailed(error, token);
						throw error;
					},
				);
		},
		applyFresh: ({ file, token }, tick) => {
			useAppStore
				.getState()
				.updateFileTabContent(tab.workspaceId, tab.id, file.content, file.meta, tick);
			buffer?.adoptRead(file, token);
		},
		keepCurrent: (tick) =>
			useAppStore
				.getState()
				.updateFileTabContent(tab.workspaceId, tab.id, tab.content, tab.meta, tick),
	});

	const content = resourceContent(bufferText ?? tab.content, tab.meta, () =>
		resourceBytesUrl(tab.workspaceId, tab.path),
	);
	const reviewSurface = dirty ? undefined : review.worktree;
	const heldFocus = dirty ? review.worktree.focus : null;
	const dropFocus = review.worktree.onFocusHandled;
	useEffect(() => {
		if (heldFocus) dropFocus();
	}, [heldFocus, dropFocus]);
	const viewRef = useRef<HTMLDivElement>(null);
	const resolveConflict = (action: () => void) => {
		action();
		focusRendererEditor(viewRef.current);
	};
	const reviews = reviewSurface ? [reviewSurface] : [];
	const showToolbar = candidates.length >= 2 || fileHasDraft;
	const saveViewState = (state: unknown) => {
		const current = useAppStore
			.getState()
			.tabsByWorkspace[tab.workspaceId]?.find((candidate) => candidate.id === tab.id);
		if (
			current?.kind === "file" &&
			(current.rendererId === undefined || current.rendererId === renderer.id) &&
			rendererImplementationKey(renderer.id, isPhoneViewport()) === implementationKey
		) {
			useAppStore.getState().setTabViewState(tab.workspaceId, tab.id, state);
		}
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			{showToolbar ? (
				<div
					data-testid="resource-view-toggle"
					role="toolbar"
					aria-label={t("panels.filePane.resourceView")}
					className="flex h-32 shrink-0 items-center justify-end gap-4 border-border-default border-b bg-container-header-bg px-12"
				>
					<SendReviewButton workspaceId={tab.workspaceId} path={tab.path} />
					<RendererToggles
						candidates={candidates}
						renderer={renderer}
						onRendererId={(rendererId) => setTabRenderer(tab.workspaceId, tab.id, rendererId)}
					/>
				</div>
			) : null}
			<UnplacedReviewStrip
				reviews={reviews}
				renderer={renderer}
				intent="view"
				candidates={candidates}
				{...(placedThreadIds ? { placedThreadIds } : {})}
				onSelectRenderer={(rendererId) => setTabRenderer(tab.workspaceId, tab.id, rendererId)}
			/>
			{buffer ? (
				<FileEditBanner
					summary={summary}
					onReload={() => resolveConflict(buffer.reload)}
					onKeepMine={() => resolveConflict(buffer.keepMine)}
				/>
			) : null}
			<div
				ref={viewRef}
				className="min-h-0 flex-1"
				data-file-buffer={editing ? buffer.key : undefined}
			>
				<Suspense fallback={loading}>
					<RendererView
						key={implementationKey}
						renderer={renderer}
						mobile={mobile}
						resource={resource}
						content={content}
						{...(editing ? { edit: buffer.session } : {})}
						{...(reviewSurface ? { review: reviewSurface } : {})}
						onPlacedThreadIds={onPlacedThreadIds}
						viewState={tab.viewState}
						onViewState={saveViewState}
					/>
				</Suspense>
			</div>
		</div>
	);
}
