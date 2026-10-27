import { RiChat2Line, RiLoginBoxLine, RiUserLine } from "@remixicon/react";
import { useT } from "@thinkrail/locales/react";
import type { PresenceTone, SurfacePresence } from "@thinkrail/resource-renderers";
import { Popover, PopoverContent, PopoverTrigger } from "@thinkrail/ui/popover";
import { cn } from "@thinkrail/ui/utils";
import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
	type ActivityAuthor,
	type FileWriter,
	fileWriter,
	fileWriters,
	nextFileActivityExpiry,
	selectFileAgentSlots,
	selectFileWrites,
	selectKnownChatTitles,
	useAppStore,
} from "../store";
import { writerLabel } from "./fileWriterLabels";

const TONE_FILL: Record<PresenceTone, string> = {
	user: "bg-primary",
	agent1: "bg-feedback-info",
	agent2: "bg-feedback-success",
	agent3: "bg-feedback-warning",
	external: "bg-text-subtle",
};

const TONE_ICON: Record<PresenceTone, string> = {
	user: "text-primary",
	agent1: "text-feedback-info",
	agent2: "text-feedback-success",
	agent3: "text-feedback-warning",
	external: "text-text-subtle",
};

const TONE_WASH: Record<PresenceTone, string> = {
	user: "bg-primary-subtle",
	agent1: "bg-feedback-info-subtle",
	agent2: "bg-feedback-success-subtle",
	agent3: "bg-feedback-warning-subtle",
	external: "bg-control-bg-hovered",
};

const KIND_ICON: Record<ActivityAuthor["kind"], typeof RiUserLine> = {
	agent: RiChat2Line,
	user: RiUserLine,
	external: RiLoginBoxLine,
};

const MAX_AVATARS = 3;

interface LabeledWriter extends FileWriter {
	label: string;
}

function chatTitle(state: Parameters<typeof selectKnownChatTitles>[0], author: ActivityAuthor) {
	return author.kind === "agent" ? (selectKnownChatTitles(state).get(author.sessionId) ?? "") : "";
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
			})),
		[writers, titles, t],
	);
}

export function useFilePresence(workspaceId: string, path: string): SurfacePresence {
	const t = useT();
	const latest = useAppStore((state) => selectFileWrites(state, workspaceId, path)[0]);
	const agents = useAppStore((state) => selectFileAgentSlots(state, workspaceId));
	const title = useAppStore((state) => (latest ? chatTitle(state, latest.author) : ""));
	return useMemo(() => {
		const hash = latest?.hash;
		const writer = latest && hash != null ? fileWriter(latest.author, agents) : null;
		if (!writer || hash == null) return {};
		const { id, tone, inferred, author } = writer;
		return {
			latest: { hash, writer: { id, tone, inferred, label: writerLabel(t, author, title) } },
		};
	}, [latest, agents, title, t]);
}

function WriterAvatar({ writer }: { writer: LabeledWriter }) {
	const Icon = KIND_ICON[writer.author.kind];
	return (
		<span
			data-testid="file-writer-avatar"
			data-writer={writer.id}
			data-tone={writer.tone}
			data-inferred={writer.inferred ? true : undefined}
			title={writer.label}
			aria-hidden
			className={cn(
				"ml-2 inline-flex size-18 shrink-0 items-center justify-center rounded-full first:ml-0",
				TONE_ICON[writer.tone],
				writer.inferred ? "bg-control-bg-hovered" : TONE_WASH[writer.tone],
			)}
		>
			<Icon className="size-12" />
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
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					data-testid="file-writers"
					aria-label={t("presence.writersNamed", { count: writers.length, names })}
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
			</PopoverTrigger>
			<PopoverContent
				side="top"
				align="end"
				data-testid="file-writers-list"
				className="px-8 py-4 tr-text-metadata"
			>
				<ul className="flex flex-col gap-2">
					{writers.map((writer) => (
						<li key={writer.id} className="flex items-center gap-8">
							<span
								aria-hidden
								className={cn(
									"size-6 shrink-0 rounded-full forced-colors:bg-[CanvasText]",
									TONE_FILL[writer.tone],
								)}
							/>
							{writer.label}
						</li>
					))}
				</ul>
			</PopoverContent>
		</Popover>
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
	const expiry = useAppStore((state) => nextFileActivityExpiry(state.fileActivityByWorkspace));
	useEffect(() => {
		if (expiry === null) return;
		const timer = setTimeout(
			() => useAppStore.getState().expireFileActivity(),
			Math.max(0, expiry - Date.now()),
		);
		return () => clearTimeout(timer);
	}, [expiry]);
}
