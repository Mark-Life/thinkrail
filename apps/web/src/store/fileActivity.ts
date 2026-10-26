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
}

interface WorkspaceFileActivity {
	paths: Record<string, readonly FileWrite[]>;
	agents: Readonly<Record<string, number>>;
	nextAgent: number;
}

export type FileActivity = Record<string, WorkspaceFileActivity>;

export const NO_FILE_WRITES: readonly FileWrite[] = [];
const NO_FILE_WRITERS: readonly FileWriter[] = [];

export const isInferredAuthor = (author: FsChangeAuthor) =>
	author.kind === "external" || (author.kind === "agent" && author.via === "script");

export const writerId = (author: FsChangeAuthor) =>
	author.kind === "agent" ? `agent:${author.sessionId}` : author.kind;

export type AgentSlots = WorkspaceFileActivity["agents"];

export function writerTone(author: FsChangeAuthor, agents: AgentSlots): FileWriterTone {
	if (author.kind === "user") return "user";
	if (author.kind === "external") return "external";
	const slot = (agents[author.sessionId] ?? 0) % AGENT_SLOTS;
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
	const current = activity[payload.workspaceId] ?? { paths: {}, agents: {}, nextAgent: 0 };
	const paths = { ...current.paths };
	let { agents, nextAgent } = current;
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
		if (write.author.kind === "agent" && agents[write.author.sessionId] === undefined) {
			agents = withAgent(agents, paths, write.author.sessionId, nextAgent++);
		}
	}
	return { ...activity, [payload.workspaceId]: { paths, agents, nextAgent } };
}

function withAgent(
	agents: AgentSlots,
	paths: WorkspaceFileActivity["paths"],
	sessionId: string,
	slot: number,
): AgentSlots {
	const next = { ...agents, [sessionId]: slot };
	const ids = Object.keys(next);
	if (ids.length <= SLOTS_PER_WORKSPACE) return next;
	const live = new Set<string>();
	for (const writes of Object.values(paths)) {
		for (const { author } of writes) if (author.kind === "agent") live.add(author.sessionId);
	}
	const byAge = ids.sort((a, b) => (next[a] ?? 0) - (next[b] ?? 0));
	const evicted = byAge.find((id) => !live.has(id)) ?? byAge[0];
	return Object.fromEntries(Object.entries(next).filter(([id]) => id !== evicted));
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
	agents: AgentSlots,
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
		});
	}
	return writers.length > 0 ? writers : NO_FILE_WRITERS;
}
