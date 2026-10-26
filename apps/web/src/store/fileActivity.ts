import type { FileRead, FsChangeAuthor, WorkspaceFsChangedPayload } from "@thinkrail/contracts";

export const FILE_ACTIVITY_WINDOW_MS = 60_000;
const WRITES_PER_PATH = 8;
const SAVES_PER_PATH = 4;
const AGENT_SLOTS = 3;
const SLOTS_PER_WORKSPACE = 64;

export type ActivityAuthor =
	| Exclude<FsChangeAuthor, { kind: "user" }>
	| { kind: "user"; mine: boolean };

export interface FileWrite {
	author: ActivityAuthor;
	hash: string | null;
	seen: number;
}

type FileWriterTone = "user" | "agent1" | "agent2" | "agent3" | "external";

export interface FileWriter {
	id: string;
	author: ActivityAuthor;
	tone: FileWriterTone;
	inferred: boolean;
}

interface OwnSave {
	hash: string | null;
	seen: number;
}

interface WorkspaceFileActivity {
	paths: Record<string, readonly FileWrite[]>;
	saves: Record<string, readonly OwnSave[]>;
	agents: Readonly<Record<string, number>>;
	nextAgent: number;
}

export type FileActivity = Record<string, WorkspaceFileActivity>;

export const NO_FILE_WRITES: readonly FileWrite[] = [];
const NO_FILE_WRITERS: readonly FileWriter[] = [];
const EMPTY_WORKSPACE: WorkspaceFileActivity = { paths: {}, saves: {}, agents: {}, nextAgent: 0 };

const isMine = (author: ActivityAuthor) => author.kind === "user" && author.mine;

const isInferredAuthor = (author: ActivityAuthor) =>
	author.kind === "external" || (author.kind === "agent" && author.via === "script");

const writerId = (author: ActivityAuthor) =>
	author.kind === "agent"
		? `agent:${author.sessionId}`
		: author.kind === "user" && !author.mine
			? "user:elsewhere"
			: author.kind;

export type AgentSlots = WorkspaceFileActivity["agents"];

function writerTone(author: ActivityAuthor, agents: AgentSlots): FileWriterTone {
	if (author.kind === "user") return "user";
	if (author.kind === "external") return "external";
	const slot = (agents[author.sessionId] ?? 0) % AGENT_SLOTS;
	return slot === 0 ? "agent1" : slot === 1 ? "agent2" : "agent3";
}

function activityAuthor(
	author: FsChangeAuthor,
	hash: string | null,
	saves: readonly OwnSave[],
	seen: number,
): ActivityAuthor {
	if (author.kind !== "user") return author;
	const mine = saves.some(
		(save) => save.hash === hash && seen - save.seen < FILE_ACTIVITY_WINDOW_MS,
	);
	return { kind: "user", mine };
}

function capWrites(writes: readonly FileWrite[]): FileWrite[] {
	let mine = 0;
	let others = 0;
	return writes.filter((write) =>
		isMine(write.author) ? ++mine <= 1 : ++others <= WRITES_PER_PATH,
	);
}

export function withOwnFileSave(
	activity: FileActivity,
	save: { workspaceId: string; path: string; hash: string | null; seen: number },
): FileActivity {
	const current = activity[save.workspaceId] ?? EMPTY_WORKSPACE;
	const previous = (current.saves[save.path] ?? []).filter((entry) => entry.hash !== save.hash);
	const saves = {
		...current.saves,
		[save.path]: [{ hash: save.hash, seen: save.seen }, ...previous].slice(0, SAVES_PER_PATH),
	};
	return { ...activity, [save.workspaceId]: { ...current, saves } };
}

interface FoldedWrite extends FileWrite {
	path: string;
}

function foldWrites(
	current: WorkspaceFileActivity,
	writes: readonly FoldedWrite[],
): WorkspaceFileActivity {
	const paths = { ...current.paths };
	let { agents, nextAgent } = current;
	for (const { path, author, hash, seen } of writes) {
		const kept = (paths[path] ?? []).filter(
			(previous) =>
				seen - previous.seen < FILE_ACTIVITY_WINDOW_MS &&
				(previous.hash !== hash || writerId(previous.author) !== writerId(author)),
		);
		paths[path] = capWrites([{ author, hash, seen }, ...kept].sort((a, b) => b.seen - a.seen));
		if (author.kind === "agent" && agents[author.sessionId] === undefined) {
			agents = withAgent(agents, paths, author.sessionId, nextAgent++);
		}
	}
	return { ...current, paths, agents, nextAgent };
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
	const current = activity[payload.workspaceId] ?? EMPTY_WORKSPACE;
	const writes = entries.map(([path, write]) => ({
		path,
		author: activityAuthor(write.author, write.hash, current.saves[path] ?? [], seen),
		hash: write.hash,
		seen,
	}));
	return { ...activity, [payload.workspaceId]: foldWrites(current, writes) };
}

export function withFileReadActivity(
	activity: FileActivity,
	read: { workspaceId: string; path: string; file: FileRead; now: number },
): FileActivity {
	const last = read.file.lastWrite;
	const hash = read.file.meta.hash;
	if (!last || hash === null) return activity;
	const seen = Math.min(read.now, last.at);
	if (read.now - seen >= FILE_ACTIVITY_WINDOW_MS) return activity;
	const current = activity[read.workspaceId] ?? EMPTY_WORKSPACE;
	if ((current.paths[read.path] ?? []).some((write) => write.hash === hash)) return activity;
	const author: ActivityAuthor =
		last.author.kind === "user" ? { kind: "user", mine: last.author.thisClient } : last.author;
	return {
		...activity,
		[read.workspaceId]: foldWrites(current, [{ path: read.path, author, hash, seen }]),
	};
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

function liveByPath<T extends { seen: number }>(
	byPath: Record<string, readonly T[]>,
	now: number,
): Record<string, readonly T[]> | null {
	let changed = false;
	const live: Record<string, readonly T[]> = {};
	for (const [path, entries] of Object.entries(byPath)) {
		const kept = entries.filter((entry) => now - entry.seen < FILE_ACTIVITY_WINDOW_MS);
		if (kept.length !== entries.length) changed = true;
		if (kept.length > 0) live[path] = kept.length === entries.length ? entries : kept;
	}
	return changed ? live : null;
}

export function pruneFileActivity(activity: FileActivity, now: number): FileActivity {
	let changed = false;
	const next: FileActivity = {};
	for (const [workspaceId, workspace] of Object.entries(activity)) {
		const paths = liveByPath(workspace.paths, now);
		const saves = liveByPath(workspace.saves, now);
		if (!paths && !saves) {
			next[workspaceId] = workspace;
			continue;
		}
		changed = true;
		next[workspaceId] = {
			...workspace,
			...(paths ? { paths } : {}),
			...(saves ? { saves } : {}),
		};
	}
	return changed ? next : activity;
}

const expiries = new WeakMap<FileActivity, number | null>();

export function nextFileActivityExpiry(activity: FileActivity): number | null {
	const cached = expiries.get(activity);
	if (cached !== undefined) return cached;
	let earliest: number | null = null;
	for (const workspace of Object.values(activity)) {
		for (const entries of [...Object.values(workspace.paths), ...Object.values(workspace.saves)]) {
			for (const { seen } of entries) {
				const expiry = seen + FILE_ACTIVITY_WINDOW_MS;
				if (earliest === null || expiry < earliest) earliest = expiry;
			}
		}
	}
	expiries.set(activity, earliest);
	return earliest;
}

export function fileWriter(author: ActivityAuthor, agents: AgentSlots): FileWriter | null {
	if (isMine(author)) return null;
	return {
		id: writerId(author),
		author,
		tone: writerTone(author, agents),
		inferred: isInferredAuthor(author),
	};
}

export function fileWriters(
	writes: readonly FileWrite[],
	agents: AgentSlots,
): readonly FileWriter[] {
	const writers: FileWriter[] = [];
	for (const { author } of writes) {
		const writer = fileWriter(author, agents);
		if (writer && !writers.some((known) => known.id === writer.id)) writers.push(writer);
	}
	return writers.length > 0 ? writers : NO_FILE_WRITERS;
}
