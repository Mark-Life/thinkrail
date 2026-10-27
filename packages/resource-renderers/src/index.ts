export {
	type MarkdownRehypePlugins,
	type ResourceCodeHost,
	type ResourceCodeLanguage,
	ResourceEnvironmentProvider,
	type ResourceFileReviewProps,
	type ResourceHost,
	ResourceHostProvider,
	type ResourceMarkdown,
	type ResourceMarkdownProps,
	type ResourcePreferences,
	ResourcePreferencesProvider,
	type ResourceReviewSendProps,
	type ResourceScope,
	ResourceScopeProvider,
	useOptionalResourceHost,
	useResourceScope,
} from "./host";
export {
	type AnchorDraft,
	anchorLabel,
	CONFLICT_CHOICE_LABELS,
	CONFLICT_CHOICES,
	CommentRefused,
	type ConflictChoice,
	canonicalWorkspacePath,
	describeResource,
	diffRendererCapabilities,
	diffResourceMeta,
	type EditConflict,
	type EditUpdate,
	type HunkActions,
	type HunkTriage,
	isPlaceable,
	type LocalEditKind,
	outdatedReason,
	PENDING_TEXT_META,
	type ResourceAnchorCapability,
	type ResourceContent,
	type ResourceDescriptor,
	type ResourceDiffProps,
	type ResourceEditSession,
	type ResourceEnvironment,
	type ResourceIntent,
	type ResourceRenderer,
	type ResourceViewModule,
	type ResourceViewProps,
	type ReviewThread,
	type ReviewThreadActions,
	registerResourceRenderer,
	rendererImplementationKey,
	resolveRenderers,
	resourceContent,
	type SurfaceReview,
	type TextChange,
	type TextRange,
	threadLabel,
} from "./registry";
export { createAskAgentRequest } from "./renderers/code/changeBlocks";
export { registerBundledResourceRenderers } from "./renderers/register";
export { ReviewDraftContext, type ReviewDraftPersistence } from "./renderers/reviewDraftState";
export { GuardedRendererDiff } from "./support/GuardedRendererDiff";
export { surfaceLineCount, VIRTUALIZED_DIFF_LINES } from "./support/largeDiff";
export { type RendererLayout, RendererToggles } from "./support/RendererToggles";
export {
	ResourcePreview,
	type ResourcePreviewLayout,
	type ResourcePreviewProps,
} from "./support/ResourcePreview";
export { ReviewThreadCard } from "./support/ReviewThreadCard";
export {
	focusRendererEditor,
	RendererView,
	usePreloadResourceView,
	useRendererSelection,
} from "./support/rendererMount";
export { UnplacedReviewStrip } from "./support/UnplacedReviewStrip";
export { useScrollViewState, viewStateScrollTop } from "./support/useScrollViewState";
