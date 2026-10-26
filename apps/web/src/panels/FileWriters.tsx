import type { FsChangeAuthor } from "@thinkrail/contracts";
import { type Translator, useT } from "@thinkrail/locales/react";
import type { SurfacePresence } from "@thinkrail/resource-renderers";
import { cn } from "@thinkrail/ui/utils";
import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
	type FileWriter,
	type FileWriterTone,
	fileWriters,
	isInferredAuthor,
	nextFileActivityExpiry,
	selectFileAgentSlots,
	selectFileLastWriterTone,
	selectFileWrites,
	selectKnownChatLocation,
	useAppStore,
	writerId,
	writerTone,
} from "../store";

const TONE_FILL: Record<FileWriterTone, string> = {
	user: "bg-primary",
	agent1: "bg-feedback-info",
	agent2: "bg-feedback-success",
	agent3: "bg-feedback-warning",
	external: "bg-text-subtle",
};

const TONE_RING: Record<FileWriterTone, string> = {
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

function chatTitle(state: Parameters<typeof selectKnownChatLocation>[0], author: FsChangeAuthor) {
	return author.kind === "agent"
		? (selectKnownChatLocation(state, author.sessionId)?.title ?? "")
		: "";
}

function writerLabel(t: Translator, author: FsChangeAuthor, title: string): string {
	if (author.kind === "user") return t("presence.you");
	if (author.kind === "external") return t("presence.external");
	const name = title ? t("presence.agentNamed", { name: title }) : t("presence.agent");
	return author.via === "script" ? t("presence.viaScript", { name }) : name;
}

function writerInitial(t: Translator, author: FsChangeAuthor, title: string): string {
	const source =
		author.kind === "agent" && title
			? title
			: author.kind === "external"
				? t("presence.external")
				: author.kind === "user"
					? t("presence.you")
					: t("presence.agent");
	return Array.from(source.trim())[0]?.toUpperCase() ?? "";
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
	const writes = useAppStore((state) => selectFileWrites(state, workspaceId, path));
	const agents = useAppStore((state) => selectFileAgentSlots(state, workspaceId));
	const titles = useAppStore(
		useShallow((state) => writes.map((write) => chatTitle(state, write.author))),
	);
	return useMemo(
		() => ({
			writes: writes.flatMap((write, index) => {
				if (write.hash === null) return [];
				const title = titles[index] ?? "";
				return [
					{
						hash: write.hash,
						writer: {
							id: writerId(write.author),
							label: writerLabel(t, write.author, title),
							tone: writerTone(write.author, agents),
							inferred: isInferredAuthor(write.author),
						},
					},
				];
			}),
		}),
		[writes, agents, titles, t],
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
		</span>
	);
}

export function FileWritersChip({ workspaceId, path }: { workspaceId: string; path: string }) {
	const t = useT();
	const writers = useLabeledWriters(workspaceId, path);
	if (writers.length === 0) return null;
	const names = writers.map((writer) => writer.label).join(", ");
	return (
		<div
			data-testid="file-writers"
			className="flex h-24 shrink-0 items-center justify-end gap-4 border-border-default border-b bg-container-header-bg px-12"
		>
			<span
				role="status"
				aria-label={t("presence.writersList", { names })}
				title={names}
				className="inline-flex items-center gap-4 rounded-full border border-border-default px-8 tr-text-metadata text-text-muted"
			>
				<span className="inline-flex items-center" aria-hidden>
					{writers.slice(0, MAX_AVATARS).map((writer) => (
						<WriterAvatar key={writer.id} writer={writer} />
					))}
				</span>
				<span aria-hidden>{t("presence.writers", { count: writers.length })}</span>
			</span>
		</div>
	);
}

export function FileWriterDot({ workspaceId, path }: { workspaceId: string; path: string }) {
	const t = useT();
	const tone = useAppStore((state) => selectFileLastWriterTone(state, workspaceId, path));
	const writers = useLabeledWriters(workspaceId, tone === null ? "" : path);
	const last = writers[0];
	if (tone === null || !last) return null;
	return (
		<span
			role="img"
			data-testid="file-writer-dot"
			data-tone={tone}
			aria-label={t("presence.lastWriter", { name: last.label })}
			title={last.label}
			className={cn(
				"mr-4 size-6 shrink-0 rounded-full forced-colors:bg-[CanvasText]",
				TONE_FILL[tone],
			)}
		/>
	);
}

export function useFileActivityPrune() {
	const expiry = useAppStore((state) => nextFileActivityExpiry(state.fileActivityByWorkspace));
	useEffect(() => {
		if (expiry === null) return;
		const timer = setTimeout(
			() => useAppStore.getState().pruneFileActivity(Date.now()),
			Math.max(0, expiry - Date.now()),
		);
		return () => clearTimeout(timer);
	}, [expiry]);
}
