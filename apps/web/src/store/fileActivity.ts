import type { FsChangeAuthor, WorkspaceFsChangedPayload } from "@thinkrail/contracts";

export const FILE_ACTIVITY_WINDOW_MS = 60_000;
const WRITES_PER_PATH = 8;
const AGENT_SLOTS = 3;
const SLOTS_PER_WORKSPACE = 64;

export interface FileWrite {
	author: FsChangeAuthor;
	hash: string | null;
	seen: number;
}

export type FileWriterTone = "user" | "agent1" | "agent2" | "agent3" | "external";

export interface FileWriter {
	id: string;
	author: Exclude<FsChangeAuthor, { kind: "user" }>;
	tone: FileWriterTone;
	inferred: boolean;
	seen: number;
}

export interface WorkspaceFileActivity {
	paths: Record<string, readonly FileWrite[]>;
	agents: readonly string[];
}

export type FileActivity = Record<string, WorkspaceFileActivity>;

export const NO_FILE_WRITES: readonly FileWrite[] = [];
export const NO_FILE_WRITERS: readonly FileWriter[] = [];

export const isInferredAuthor = (author: FsChangeAuthor) =>
	author.kind === "external" || (author.kind === "agent" && author.via === "script");

export const writerId = (author: FsChangeAuthor) =>
	author.kind === "agent" ? `agent:${author.sessionId}` : author.kind;

export function writerTone(author: FsChangeAuthor, agents: readonly string[]): FileWriterTone {
	if (author.kind === "user") return "user";
	if (author.kind === "external") return "external";
	const slot = Math.max(agents.indexOf(author.sessionId), 0) % AGENT_SLOTS;
	return slot === 0 ? "agent1" : slot === 1 ? "agent2" : "agent3";
}

export function withFsChangeActivity(
	activity: FileActivity,
	payload: WorkspaceFsChangedPayload,
	seen: number,
): FileActivity {
	const authors = payload.authors;
	if (!authors) return activity;
	const entries = Object.entries(authors);
	if (entries.length === 0) return activity;
	const current = activity[payload.workspaceId] ?? { paths: {}, agents: [] };
	const paths = { ...current.paths };
	let agents = current.agents;
	for (const [path, write] of entries) {
		const kept = (paths[path] ?? []).filter(
			(previous) =>
				seen - previous.seen < FILE_ACTIVITY_WINDOW_MS &&
				(previous.hash !== write.hash || writerId(previous.author) !== writerId(write.author)),
		);
		paths[path] = [{ author: write.author, hash: write.hash, seen }, ...kept].slice(
			0,
			WRITES_PER_PATH,
		);
		if (write.author.kind === "agent" && !agents.includes(write.author.sessionId)) {
			agents = [...agents, write.author.sessionId].slice(-SLOTS_PER_WORKSPACE);
		}
	}
	return { ...activity, [payload.workspaceId]: { paths, agents } };
}

export function pruneFileActivity(activity: FileActivity, now: number): FileActivity {
	let changed = false;
	const next: FileActivity = {};
	for (const [workspaceId, workspace] of Object.entries(activity)) {
		const paths: Record<string, readonly FileWrite[]> = {};
		let workspaceChanged = false;
		for (const [path, writes] of Object.entries(workspace.paths)) {
			const live = writes.filter((write) => now - write.seen < FILE_ACTIVITY_WINDOW_MS);
			if (live.length !== writes.length) workspaceChanged = true;
			if (live.length > 0) paths[path] = live.length === writes.length ? writes : live;
		}
		if (!workspaceChanged) {
			next[workspaceId] = workspace;
			continue;
		}
		changed = true;
		next[workspaceId] = { ...workspace, paths };
	}
	return changed ? next : activity;
}

export function nextFileActivityExpiry(activity: FileActivity): number | null {
	let earliest: number | null = null;
	for (const workspace of Object.values(activity)) {
		for (const writes of Object.values(workspace.paths)) {
			for (const write of writes) {
				const expiry = write.seen + FILE_ACTIVITY_WINDOW_MS;
				if (earliest === null || expiry < earliest) earliest = expiry;
			}
		}
	}
	return earliest;
}

export function fileWriters(
	writes: readonly FileWrite[],
	agents: readonly string[],
): readonly FileWriter[] {
	const writers: FileWriter[] = [];
	for (const write of writes) {
		const { author } = write;
		if (author.kind === "user") continue;
		const id = writerId(author);
		if (writers.some((writer) => writer.id === id)) continue;
		writers.push({
			id,
			author,
			tone: writerTone(author, agents),
			inferred: isInferredAuthor(author),
			seen: write.seen,
		});
	}
	return writers.length > 0 ? writers : NO_FILE_WRITERS;
}

export function workspaceWriterCount(workspace: WorkspaceFileActivity | undefined): number {
	if (!workspace) return 0;
	const ids = new Set<string>();
	for (const writes of Object.values(workspace.paths)) {
		for (const write of writes) if (write.author.kind !== "user") ids.add(writerId(write.author));
	}
	return ids.size;
}

export function lastWriterTone(
	workspace: WorkspaceFileActivity | undefined,
	path: string,
): FileWriterTone | null {
	const last = workspace?.paths[path]?.find((write) => write.author.kind !== "user");
	return last && workspace ? writerTone(last.author, workspace.agents) : null;
}
