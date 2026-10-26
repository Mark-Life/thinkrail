import { useT } from "@thinkrail/locales/react";
import type { PresenceTone, SurfacePresence } from "@thinkrail/resource-renderers";
import { Tooltip, TooltipContent, TooltipTrigger } from "@thinkrail/ui/tooltip";
import { cn } from "@thinkrail/ui/utils";
import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
	type ActivityAuthor,
	type FileWriter,
	fileWriters,
	isInferredAuthor,
	isMine,
	nextFileActivityExpiry,
	selectFileAgentSlots,
	selectFileWrites,
	selectKnownChatLocation,
	useAppStore,
	writerId,
	writerTone,
} from "../store";
import { writerInitial, writerLabel } from "./fileWriterLabels";

const TONE_FILL: Record<PresenceTone, string> = {
	user: "bg-primary",
	agent1: "bg-feedback-info",
	agent2: "bg-feedback-success",
	agent3: "bg-feedback-warning",
	external: "bg-text-subtle",
};

const TONE_RING: Record<PresenceTone, string> = {
	user: "border-primary",
	agent1: "border-feedback-info",
	agent2: "border-feedback-success",
	agent3: "border-feedback-warning",
	external: "border-text-subtle",
};

const MAX_AVATARS = 3;

interface LabeledWriter extends FileWriter {
	label: string;
	initial: string;
}

function chatTitle(state: Parameters<typeof selectKnownChatLocation>[0], author: ActivityAuthor) {
	return author.kind === "agent"
		? (selectKnownChatLocation(state, author.sessionId)?.title ?? "")
		: "";
}

function useLabeledWriters(workspaceId: string, path: string): readonly LabeledWriter[] {
	const t = useT();
	const writes = useAppStore((state) => selectFileWrites(state, workspaceId, path));
	const agents = useAppStore((state) => selectFileAgentSlots(state, workspaceId));
	const writers = useMemo(() => fileWriters(writes, agents), [writes, agents]);
	const titles = useAppStore(
		useShallow((state) => writers.map((writer) => chatTitle(state, writer.author))),
	);
	return useMemo(
		() =>
			writers.map((writer, index) => ({
				...writer,
				label: writerLabel(t, writer.author, titles[index] ?? ""),
				initial: writerInitial(t, writer.author, titles[index] ?? ""),
			})),
		[writers, titles, t],
	);
}

export function useFilePresence(workspaceId: string, path: string): SurfacePresence {
	const t = useT();
	const latest = useAppStore((state) => selectFileWrites(state, workspaceId, path)[0]);
	const agents = useAppStore((state) => selectFileAgentSlots(state, workspaceId));
	const title = useAppStore((state) => (latest ? chatTitle(state, latest.author) : ""));
	return useMemo(
		() =>
			latest?.hash == null || isMine(latest.author)
				? {}
				: {
						latest: {
							hash: latest.hash,
							writer: {
								id: writerId(latest.author),
								label: writerLabel(t, latest.author, title),
								tone: writerTone(latest.author, agents),
								inferred: isInferredAuthor(latest.author),
							},
						},
					},
		[latest, agents, title, t],
	);
}

function WriterAvatar({ writer }: { writer: LabeledWriter }) {
	return (
		<span
			data-testid="file-writer-avatar"
			data-writer={writer.id}
			data-tone={writer.tone}
			data-inferred={writer.inferred ? true : undefined}
			title={writer.label}
			aria-hidden
			className={cn(
				"-ml-2 inline-flex size-14 shrink-0 items-center justify-center rounded-full border-2 bg-container-elevated-bg text-text-default first:ml-0 forced-colors:border-[CanvasText]",
				"tr-text-label-pill",
				TONE_RING[writer.tone],
				writer.inferred && "border-dashed",
			)}
		>
			{writer.initial}
		</span>
	);
}

function Overflow({ writers }: { writers: readonly LabeledWriter[] }) {
	const t = useT();
	const extra = writers.length - MAX_AVATARS;
	if (extra <= 0) return null;
	return (
		<span
			data-testid="file-writer-overflow"
			aria-hidden
			className="ml-2 tr-text-label-pill text-text-muted"
		>
			{t("presence.moreWriters", { extra })}
		</span>
	);
}

export function FileWriterAvatars({ workspaceId, path }: { workspaceId: string; path: string }) {
	const t = useT();
	const writers = useLabeledWriters(workspaceId, path);
	if (writers.length === 0) return null;
	return (
		<span
			role="img"
			data-testid="file-writer-avatars"
			aria-label={t("presence.writersList", {
				names: writers.map((writer) => writer.label).join(", "),
			})}
			className="mr-4 inline-flex shrink-0 items-center"
		>
			{writers.slice(0, MAX_AVATARS).map((writer) => (
				<WriterAvatar key={writer.id} writer={writer} />
			))}
			<Overflow writers={writers} />
		</span>
	);
}

export function FileWritersChip({
	workspaceId,
	path,
	className,
}: {
	workspaceId: string;
	path: string;
	className?: string;
}) {
	const t = useT();
	const writers = useLabeledWriters(workspaceId, path);
	if (writers.length === 0) return null;
	const names = writers.map((writer) => writer.label).join(", ");
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					data-testid="file-writers"
					aria-label={t("presence.writersList", { names })}
					className={cn(
						"inline-flex items-center gap-4 rounded-full border border-border-default bg-container-elevated-bg px-8 py-2 tr-text-metadata text-text-muted shadow-[var(--shadow-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
						className,
					)}
				>
					<span className="inline-flex items-center" aria-hidden>
						{writers.slice(0, MAX_AVATARS).map((writer) => (
							<WriterAvatar key={writer.id} writer={writer} />
						))}
						<Overflow writers={writers} />
					</span>
					<span aria-hidden>{t("presence.writers", { count: writers.length })}</span>
				</button>
			</TooltipTrigger>
			<TooltipContent>{names}</TooltipContent>
		</Tooltip>
	);
}

export function FileWriterDot({ workspaceId, path }: { workspaceId: string; path: string }) {
	const t = useT();
	const [last] = useLabeledWriters(workspaceId, path);
	if (!last) return null;
	return (
		<span
			role="img"
			data-testid="file-writer-dot"
			data-tone={last.tone}
			aria-label={t("presence.lastWriter", { name: last.label })}
			title={last.label}
			className={cn(
				"mr-4 size-6 shrink-0 rounded-full forced-colors:bg-[CanvasText]",
				TONE_FILL[last.tone],
			)}
		/>
	);
}

export function useFileActivityPrune() {
	const activity = useAppStore((state) => state.fileActivityByWorkspace);
	const expiry = useMemo(() => nextFileActivityExpiry(activity), [activity]);
	useEffect(() => {
		if (expiry === null) return;
		const timer = setTimeout(
			() => useAppStore.getState().expireFileActivity(),
			Math.max(0, expiry - Date.now()),
		);
		return () => clearTimeout(timer);
	}, [expiry]);
}
