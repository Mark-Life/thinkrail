import { useT } from "@thinkrail/locales/react";
import { LoadingRegion } from "@thinkrail/ui/skeleton";
import { cn } from "@thinkrail/ui/utils";
import {
	type CSSProperties,
	type ReactNode,
	type Ref,
	Suspense,
	useEffect,
	useLayoutEffect,
	useMemo,
	useState,
} from "react";
import {
	ResourceEnvironmentProvider,
	useResourceEnvironment,
	useResourceHost,
	useResourceScope,
} from "../host";
import {
	canonicalWorkspacePath,
	describeResource,
	diffResourceMeta,
	type ResourceRenderer,
	type SurfaceReview,
} from "../registry";
import { GuardedRendererDiff } from "./GuardedRendererDiff";
import { surfaceLineCount } from "./largeDiff";
import {
	forgetNaturalHeight,
	naturalHeightKey,
	rememberedNaturalHeight,
	rememberNaturalHeight,
} from "./naturalHeights";
import { type RendererLayout, RendererToggles } from "./RendererToggles";
import { RendererView, useRendererSelection } from "./rendererMount";
import { UnplacedReviewStrip } from "./UnplacedReviewStrip";
import {
	type FileState,
	type LoadedFile,
	type ReadyFile,
	startWorkspaceFileReads,
	updateFileState,
} from "./workspaceFileReads";

export type ResourcePreviewLayout = "split" | "unified";

export interface ResourcePreviewProps {
	path: string;
	before?: string | undefined;
	workspaceId?: string | undefined;
	rendererId?: string | undefined;
	onRendererId?: ((rendererId: string) => void) | undefined;
	layout?: ResourcePreviewLayout | undefined;
	onLayout?: ((layout: ResourcePreviewLayout) => void) | undefined;
	viewState?: unknown;
	onViewState?: ((viewState: unknown) => void) | undefined;
	leading?: ReactNode;
	actions?: ReactNode;
	className?: string | undefined;
	compact?: boolean | undefined;
	fitContent?: boolean | undefined;
}

interface ResolvedProps extends ResourcePreviewProps {
	workspaceId: string;
	sessionId: string | undefined;
	rendererId: string | undefined;
	onRendererId: (rendererId: string) => void;
}

const LOADING: LoadedFile = { status: "loading" };

function implementationViewState(
	props: Pick<ResourcePreviewProps, "viewState" | "onViewState">,
	implementation: string,
): { viewState: unknown; onViewState?: (state: unknown) => void } {
	const { viewState, onViewState } = props;
	const own =
		typeof viewState === "object" &&
		viewState !== null &&
		Reflect.get(viewState, "implementation") === implementation;
	return {
		viewState: own ? Reflect.get(viewState, "state") : undefined,
		...(onViewState
			? { onViewState: (state: unknown) => onViewState({ implementation, state }) }
			: {}),
	};
}

const loading = <LoadingRegion rows={8} className="h-full p-12" />;

const HELD_HEIGHT = "h-[var(--resource-preview-height)]";

function heldHeightStyle(height: number | undefined): CSSProperties | undefined {
	return height === undefined
		? undefined
		: ({ "--resource-preview-height": `${height}px` } as CSSProperties);
}

function LoadingFrame({
	className,
	heightKey,
}: {
	className: string | undefined;
	heightKey: string | null;
}) {
	const [height] = useState(() =>
		heightKey === null ? undefined : rememberedNaturalHeight(heightKey),
	);
	return (
		<div
			className={cn(className, height !== undefined && HELD_HEIGHT)}
			style={heldHeightStyle(height)}
		>
			{loading}
		</div>
	);
}

function useNaturalFrame({
	fit,
	heightKey,
	implementationKey,
	hashes,
}: {
	fit: boolean;
	heightKey: string;
	implementationKey: string;
	hashes: readonly (string | null)[];
}) {
	const stamp =
		fit && !hashes.includes(null) ? [implementationKey, ...hashes].join("\u0000") : null;
	const [naturalKey, setNaturalKey] = useState<string | null>(null);
	const [held, setHeld] = useState(() => {
		const height = stamp === null ? undefined : rememberedNaturalHeight(heightKey, stamp);
		return height === undefined ? null : { stamp, height };
	});
	const [frame, setFrame] = useState<HTMLDivElement | null>(null);
	const natural = fit && naturalKey === implementationKey;

	useLayoutEffect(() => {
		if (!frame || !natural || stamp === null) return;
		const remember = () => {
			const { height } = frame.getBoundingClientRect();
			if (height > 0) rememberNaturalHeight(heightKey, stamp, height);
		};
		remember();
		const observer = new ResizeObserver(remember);
		observer.observe(frame);
		return () => observer.disconnect();
	}, [frame, natural, heightKey, stamp]);

	return {
		natural,
		heldHeight: !natural && held?.stamp === stamp ? held.height : undefined,
		frameRef: setFrame,
		onNaturalHeight: (next: boolean) => {
			if (next) setHeld(null);
			else if (natural) forgetNaturalHeight(heightKey);
			setNaturalKey(next ? implementationKey : null);
		},
	};
}

function useWorkspaceFile(workspaceId: string, path: string | undefined): LoadedFile {
	const { readFile, subscribeFileChanges, bytesUrl } = useResourceHost();
	const [state, setState] = useState<FileState | null>(null);
	const fileKey = `${workspaceId}\u0000${path ?? ""}`;

	useEffect(() => {
		if (path === undefined) return;
		return startWorkspaceFileReads({
			read: () => readFile(workspaceId, path),
			subscribe: (onChange) =>
				subscribeFileChanges(workspaceId, (paths) => {
					if (paths === null || paths.includes(path)) onChange();
				}),
			bytesUrl: () => bytesUrl(workspaceId, path),
			update: (next) => setState((current) => updateFileState(current, fileKey, next)),
		});
	}, [readFile, subscribeFileChanges, bytesUrl, workspaceId, path, fileKey]);

	return state?.file === fileKey ? state.loaded : LOADING;
}

export function ResourcePreview(props: ResourcePreviewProps) {
	const scope = useResourceScope();
	const environment = useResourceEnvironment();
	const workspaceId = props.workspaceId ?? scope?.workspaceId;
	if (!workspaceId)
		throw new Error("ResourcePreview needs a workspace: pass workspaceId or a scope");
	const sessionId = scope?.workspaceId === workspaceId ? scope.sessionId : undefined;
	const preview = (
		<ScopedResourcePreview {...props} workspaceId={workspaceId} sessionId={sessionId} />
	);
	const compact = props.compact ?? environment.compact ?? false;
	if (compact === (environment.compact ?? false)) return preview;
	return (
		<ResourceEnvironmentProvider value={{ ...environment, compact }}>
			{preview}
		</ResourceEnvironmentProvider>
	);
}

function ScopedResourcePreview(
	props: ResourcePreviewProps & { workspaceId: string; sessionId: string | undefined },
) {
	const t = useT();
	const [localRenderer, setLocalRenderer] = useState<string | undefined>(undefined);
	const path = canonicalWorkspacePath(props.path);
	const requested = props.before === undefined ? undefined : canonicalWorkspacePath(props.before);
	const before = requested === path ? undefined : requested;
	const resolved: ResolvedProps = {
		...props,
		path,
		before,
		rendererId: props.onRendererId ? props.rendererId : localRenderer,
		onRendererId: props.onRendererId ?? setLocalRenderer,
	};
	const { workspaceId } = resolved;
	const modified = useWorkspaceFile(workspaceId, path);
	const original = useWorkspaceFile(workspaceId, before);
	const failure =
		modified.status === "error"
			? { path, message: modified.message }
			: before !== undefined && original.status === "error"
				? { path: before, message: original.message }
				: null;

	if (failure) {
		return (
			<div
				data-testid="resource-preview-error"
				className="rounded-sm border border-border-default px-8 py-4 text-feedback-error tr-text-metadata"
			>
				{t("viewer.preview.loadFailed", { path: failure.path, message: failure.message })}
			</div>
		);
	}
	if (modified.status !== "ready" || (before !== undefined && original.status !== "ready")) {
		return (
			<LoadingFrame
				className={props.className}
				heightKey={props.fitContent === true ? naturalHeightKey(workspaceId, path, before) : null}
			/>
		);
	}
	return before !== undefined && original.status === "ready" ? (
		<PreviewDiff {...resolved} before={before} original={original} modified={modified} />
	) : (
		<PreviewView {...resolved} file={modified} />
	);
}

function StaleNotice({ files }: { files: readonly { path: string; file: ReadyFile }[] }) {
	const t = useT();
	const stale = files.filter(({ file }) => file.stale !== undefined);
	if (stale.length === 0) return null;
	return (
		<div
			data-testid="resource-preview-stale"
			role="status"
			className="shrink-0 border-border-default border-b bg-feedback-warning-subtle px-12 py-4 tr-text-metadata text-feedback-warning"
		>
			{stale.map(({ path, file }) => (
				<p key={path}>{t("viewer.preview.refreshFailed", { path, message: file.stale })}</p>
			))}
		</div>
	);
}

function PreviewFrame({
	testid,
	className,
	natural = false,
	heldHeight,
	frameRef,
	toolbar,
	notice,
	strip,
	children,
}: {
	testid: string;
	className: string | undefined;
	natural?: boolean;
	heldHeight?: number | undefined;
	frameRef?: Ref<HTMLDivElement>;
	toolbar: ReactNode;
	notice: ReactNode;
	strip: ReactNode;
	children: ReactNode;
}) {
	return (
		<div
			ref={frameRef}
			data-testid={testid}
			data-natural-height={natural || undefined}
			className={cn(
				"flex min-h-0 flex-col overflow-hidden bg-container-workspace-bg",
				className,
				heldHeight !== undefined && HELD_HEIGHT,
				natural && "h-auto",
			)}
			style={heldHeightStyle(heldHeight)}
		>
			{toolbar}
			{notice}
			{strip}
			<div className={natural ? "flex-none" : "min-h-0 flex-1"}>
				<Suspense fallback={loading}>{children}</Suspense>
			</div>
		</div>
	);
}

function PreviewToolbar({
	props,
	paths,
	candidates,
	renderer,
	layout,
}: {
	props: ResolvedProps;
	paths: readonly string[];
	candidates: readonly ResourceRenderer[];
	renderer: ResourceRenderer;
	layout?: { value: RendererLayout; onChange: (layout: RendererLayout) => void } | undefined;
}) {
	const t = useT();
	const { ReviewSend } = useResourceHost();
	const { compact } = useResourceEnvironment();
	return (
		<div
			data-testid="resource-view-toggle"
			role="toolbar"
			aria-label={t("panels.filePane.resourceView")}
			className="flex h-32 shrink-0 items-center gap-4 border-border-default border-b bg-container-header-bg px-12"
		>
			<div className="mr-auto flex min-w-0 items-center">{props.leading}</div>
			{compact ? null : (
				<>
					<ReviewSend workspaceId={props.workspaceId} paths={paths} sessionId={props.sessionId} />
					<RendererToggles
						candidates={candidates}
						renderer={renderer}
						onRendererId={props.onRendererId}
						layout={layout}
					/>
				</>
			)}
			{props.actions}
		</div>
	);
}

function PreviewView(props: ResolvedProps & { file: ReadyFile }) {
	const { FileReview } = useResourceHost();
	return (
		<FileReview
			workspaceId={props.workspaceId}
			path={props.path}
			kind="inline"
			sessionId={props.sessionId}
		>
			{(review) => <ReviewedPreviewView {...props} review={review} />}
		</FileReview>
	);
}

function ReviewedPreviewView(props: ResolvedProps & { file: ReadyFile; review: SurfaceReview }) {
	const { workspaceId, path, file, rendererId, onRendererId, review } = props;
	const resource = useMemo(
		() => describeResource(workspaceId, path, file.meta),
		[workspaceId, path, file.meta],
	);
	const { mobile, candidates, renderer, implementationKey, placedThreadIds, onPlacedThreadIds } =
		useRendererSelection(resource, "view", rendererId);
	const paths = useMemo(() => [path], [path]);
	const reviews = useMemo(() => [review], [review]);
	const fit = props.fitContent === true;
	const { natural, heldHeight, frameRef, onNaturalHeight } = useNaturalFrame({
		fit,
		heightKey: naturalHeightKey(workspaceId, path),
		implementationKey,
		hashes: [file.meta.hash],
	});

	return (
		<PreviewFrame
			testid="resource-preview"
			className={props.className}
			natural={natural}
			heldHeight={heldHeight}
			frameRef={frameRef}
			notice={<StaleNotice files={[{ path, file }]} />}
			toolbar={
				<PreviewToolbar props={props} paths={paths} candidates={candidates} renderer={renderer} />
			}
			strip={
				<UnplacedReviewStrip
					reviews={reviews}
					renderer={renderer}
					intent="view"
					candidates={candidates}
					{...(placedThreadIds ? { placedThreadIds } : {})}
					onSelectRenderer={onRendererId}
				/>
			}
		>
			<RendererView
				key={implementationKey}
				renderer={renderer}
				mobile={mobile}
				resource={resource}
				content={file.content}
				review={review}
				onPlacedThreadIds={onPlacedThreadIds}
				{...(fit ? { onNaturalHeight } : {})}
				{...implementationViewState(props, implementationKey)}
			/>
		</PreviewFrame>
	);
}

type DiffSides = { before: string; original: ReadyFile; modified: ReadyFile };

function PreviewDiff(props: ResolvedProps & DiffSides) {
	const { FileReview } = useResourceHost();
	const { workspaceId, sessionId, path, before } = props;
	return (
		<FileReview workspaceId={workspaceId} path={path} kind="diff" sessionId={sessionId}>
			{(after) => (
				<FileReview workspaceId={workspaceId} path={before} kind="diff" sessionId={sessionId}>
					{(prior) => <ReviewedPreviewDiff {...props} after={after} prior={prior} />}
				</FileReview>
			)}
		</FileReview>
	);
}

function ReviewedPreviewDiff(
	props: ResolvedProps & DiffSides & { after: SurfaceReview; prior: SurfaceReview },
) {
	const { workspaceId, path, before, original, modified, rendererId, onRendererId, after, prior } =
		props;
	const review = useMemo(() => ({ worktree: after, base: prior }), [after, prior]);
	const descriptorMeta = useMemo(
		() => diffResourceMeta(original.meta, modified.meta),
		[original.meta, modified.meta],
	);
	const resource = useMemo(
		() => describeResource(workspaceId, path, descriptorMeta),
		[workspaceId, path, descriptorMeta],
	);
	const originalResource = useMemo(
		() => describeResource(workspaceId, before, original.meta),
		[workspaceId, before, original.meta],
	);
	const { mobile, candidates, renderer, implementationKey, placedThreadIds, onPlacedThreadIds } =
		useRendererSelection(resource, "diff", rendererId);
	const paths = useMemo(() => [path, before], [path, before]);
	const reviews = useMemo(() => [after, prior], [after, prior]);
	const layout = mobile ? "unified" : (props.layout ?? "unified");
	const { onLayout } = props;
	const lineCount = useMemo(
		() => surfaceLineCount(original.content, modified.content),
		[original.content, modified.content],
	);
	const fit = props.fitContent === true;
	const { natural, heldHeight, frameRef, onNaturalHeight } = useNaturalFrame({
		fit,
		heightKey: naturalHeightKey(workspaceId, path, before),
		implementationKey,
		hashes: [original.meta.hash, modified.meta.hash],
	});

	return (
		<PreviewFrame
			testid="resource-preview-diff"
			className={props.className}
			natural={natural}
			heldHeight={heldHeight}
			frameRef={frameRef}
			notice={
				<StaleNotice
					files={[
						{ path: before, file: original },
						{ path, file: modified },
					]}
				/>
			}
			toolbar={
				<PreviewToolbar
					props={props}
					paths={paths}
					candidates={candidates}
					renderer={renderer}
					layout={
						props.layout !== undefined && onLayout
							? { value: props.layout, onChange: onLayout }
							: undefined
					}
				/>
			}
			strip={
				<UnplacedReviewStrip
					reviews={reviews}
					renderer={renderer}
					intent="diff"
					candidates={candidates}
					{...(placedThreadIds ? { placedThreadIds } : {})}
					onSelectRenderer={onRendererId}
				/>
			}
		>
			<GuardedRendererDiff
				renderer={renderer}
				implementationKey={implementationKey}
				resource={resource}
				originalResource={originalResource}
				original={original.content}
				modified={modified.content}
				layout={layout}
				ignoreWhitespace={false}
				review={review}
				onPlacedThreadIds={onPlacedThreadIds}
				lineCount={lineCount}
				{...(fit ? { onNaturalHeight } : {})}
				{...implementationViewState(props, implementationKey)}
			/>
		</PreviewFrame>
	);
}
