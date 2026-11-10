import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	arr,
	compile,
	obj,
	oneOf,
	opt,
	str,
	unknown,
	type Validator,
} from "@earendil-works/pi-schema";
import {
	TODO_ARTIFACT_KINDS,
	TODO_ORIGINS,
	TODO_STATUSES,
	type Todo,
	type TodoArtifact,
	type TodoFile,
	type TodoGroup,
	type TodoGroupStatus,
	type TodoInput,
	type TodoOrigin,
	type TodoPatch,
	type TodoPlan,
	type TodoPromoteResult,
	type TodoStatus,
	type TodoStoreProblem,
	type TodoUpdateResult,
	type WriteItem,
	type WritePlan,
} from "./types.ts";

// Deliberate local mirror of @thinkrail/shared's WORKSPACE_CONTEXT_DIR — core/ takes no @thinkrail/* dep (see core/SPEC.md).
const CONTEXT_DIR = ".thinkrail/context";

export const STORE_DIR = `${CONTEXT_DIR}/todos`;

function assertSafeSessionId(sessionId: string): void {
	if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
		throw new Error(`Invalid session id for TODO store: ${JSON.stringify(sessionId)}`);
	}
}

export function storeRel(sessionId: string): string {
	assertSafeSessionId(sessionId);
	return `${STORE_DIR}/${sessionId}.json`;
}

export function countItems(plan: TodoPlan): number {
	return plan.todos.length + plan.groups.reduce((n, g) => n + g.todos.length, 0);
}

export function flatItems(plan: TodoPlan): Todo[] {
	return [...plan.groups.flatMap((g) => g.todos), ...plan.todos];
}

export function groupStatus(group: TodoGroup): TodoGroupStatus {
	if (group.todos.length > 0 && group.todos.every((t) => t.status === "done")) return "done";
	if (group.todos.some((t) => t.status === "in_progress")) return "active";
	return "pending";
}

const CURRENT_VERSION = 6 as const;

// Home for a stray: an agent `done` item left in the loose lane on re-plan (see core/SPEC.md).
const CARRIED_LOOSE_GROUP = "Completed";

const StoredFile = compile(
	obj(
		{ todos: opt(arr(unknown())), groups: opt(arr(unknown())), summary: opt(str()) },
		{ open: true },
	),
);
const StoredItem = compile(
	obj(
		{
			id: str(),
			title: str(),
			status: opt(oneOf(TODO_STATUSES)),
			origin: opt(oneOf(TODO_ORIGINS)),
			createdAt: opt(str()),
			updatedAt: opt(str()),
			note: opt(str()),
			summary: opt(str()),
			verification: opt(str()),
			commitSubject: opt(str()),
			artifacts: opt(arr(unknown())),
		},
		{ open: true },
	),
);
const StoredGroup = compile(
	obj({ id: opt(str()), title: str(), todos: opt(arr(unknown())) }, { open: true }),
);
const StoredArtifact = compile(
	obj(
		{
			kind: oneOf(TODO_ARTIFACT_KINDS),
			path: opt(str()),
			sha: opt(str()),
			label: opt(str()),
			specId: opt(str()),
		},
		{ open: true },
	),
);
const ArtifactWithLabel = compile(obj({ label: str() }, { open: true }));

function parseFieldwise<T>(raw: unknown, validator: Validator<T>, onDrop: () => void): T | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const fields: Record<string, unknown> = { ...raw };
	while (!validator.check(fields)) {
		const field = validator
			.errors(fields)[0]
			?.path.split("/")[1]
			?.replaceAll("~1", "/")
			.replaceAll("~0", "~");
		if (field === undefined || !Object.hasOwn(fields, field)) return null;
		delete fields[field];
		onDrop();
	}
	return fields;
}

type ProblemObserver = (problem: TodoStoreProblem) => void;

let observer: ProblemObserver | null = null;
const refusedOverwrites = new Set<string>();

export function observeTodoStoreProblems(next: ProblemObserver | null): void {
	observer = next;
}

export class TodoStoreError extends Error {
	readonly code = "STATE_FILE_UNREADABLE";

	constructor(message: string) {
		super(message);
		this.name = "TodoStoreError";
	}
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isExistingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function emptyPlan(): TodoPlan {
	return { todos: [], groups: [] };
}

function nowIso(): string {
	return new Date().toISOString();
}
function freshId(prefix: string): string {
	return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

const MARKDOWN_NL_PARAGRAPH = /(?<!\\)\\n\\n/g;
const MARKDOWN_NL_STRUCTURE = /(?<!\\)\\n(?=[-*+] |\d+\. |#{1,6} |> |```|-{3,}|={3,})/g;

function decodeUnicode(s: string): string {
	if (!s.includes("\\u")) return s;
	return s.replace(/(?<!\\)\\u([0-9a-fA-F]{4})/g, (_m, hex) =>
		String.fromCharCode(Number.parseInt(hex, 16)),
	);
}

function decodeMarkdown(s: string): string {
	const unicoded = decodeUnicode(s);
	if (!unicoded.includes("\\n")) return unicoded;
	return unicoded.replace(MARKDOWN_NL_PARAGRAPH, "\n\n").replace(MARKDOWN_NL_STRUCTURE, "\n");
}

function decodeIfAgent(s: string, origin: TodoOrigin): string {
	return origin === "agent" ? decodeUnicode(s) : s;
}

function decodeMarkdownIfAgent(s: string, origin: TodoOrigin): string {
	return origin === "agent" ? decodeMarkdown(s) : s;
}

function decodeArtifactsIfAgent(raw: unknown, origin: TodoOrigin): unknown {
	if (origin !== "agent" || !Array.isArray(raw)) return raw;
	return raw.map((entry) =>
		ArtifactWithLabel.check(entry) ? { ...entry, label: decodeUnicode(entry.label) } : entry,
	);
}

// Titles are single-line by contract (item bullets and `##` group headings in the markdown export). A
// newline from the plan's multi-line add input or an agent escape would break that list, so collapse any
// whitespace run to one space at the write boundary rather than sanitizing on every render.
function flattenTitle(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

function artifactOf(entry: unknown): TodoArtifact | null {
	if (!StoredArtifact.check(entry)) return null;
	const artifact: TodoArtifact = { kind: entry.kind };
	if (entry.path) artifact.path = entry.path;
	if (entry.sha) artifact.sha = entry.sha;
	if (entry.label) artifact.label = entry.label;
	if (entry.specId) artifact.specId = entry.specId;
	return (artifact.kind === "commit" ? artifact.sha : artifact.path) ? artifact : null;
}

function inputArtifacts(raw: unknown): TodoArtifact[] | undefined {
	const kept = Array.isArray(raw) ? raw.map(artifactOf).filter((entry) => entry !== null) : [];
	return kept.length > 0 ? kept : undefined;
}

function sanitize(raw: unknown, onDrop: () => void): Todo | null {
	const item = parseFieldwise(raw, StoredItem, onDrop);
	if (!item) return null;
	const now = nowIso();
	const todo: Todo = {
		id: item.id,
		title: flattenTitle(item.title),
		status: item.status ?? "pending",
		origin: item.origin ?? "agent",
		createdAt: item.createdAt ?? now,
		updatedAt: item.updatedAt ?? now,
	};
	if (item.note) todo.note = item.note;
	if (item.summary) todo.summary = item.summary;
	if (item.verification) todo.verification = item.verification;
	if (item.commitSubject) todo.commitSubject = item.commitSubject;
	const artifacts = keptEntries(item.artifacts, artifactOf, onDrop);
	if (artifacts.length > 0) todo.artifacts = artifacts;
	return todo;
}

function keptEntries<T>(
	raw: readonly unknown[] | undefined,
	parse: (entry: unknown) => T | null,
	onDrop: () => void,
): T[] {
	if (raw === undefined) return [];
	const kept = raw.map(parse).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
	if (kept.length < raw.length) onDrop();
	return kept;
}

function sanitizeGroup(raw: unknown, onDrop: () => void): TodoGroup | null {
	const group = parseFieldwise(raw, StoredGroup, onDrop);
	if (!group) return null;
	return {
		id: group.id ?? freshId("g"),
		title: flattenTitle(group.title),
		todos: keptEntries(group.todos, (entry) => sanitize(entry, onDrop), onDrop),
	};
}

function report(code: TodoStoreProblem["code"], message: string): void {
	observer?.({ code, message });
}

function keepCorruptCopy(file: string, raw: string, refusedBefore: boolean): void {
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 12);
	const copy = `${file}.corrupt-${hash}`;
	try {
		writeFileSync(copy, raw, { flag: "wx", mode: 0o600 });
	} catch (error) {
		if (isExistingFile(error)) return;
		refusedOverwrites.add(file);
		if (refusedBefore) return;
		report(
			"STATE_FILE_UNREADABLE",
			`${basename(file)}: a read lost data, and no copy could be kept`,
		);
		return;
	}
	report("STATE_FILE_SET_ASIDE", `${basename(file)}: a read lost data; copy at ${basename(copy)}`);
}

function makeTodo(
	title: string,
	status: TodoStatus,
	origin: TodoOrigin,
	note?: string,
	artifacts?: TodoArtifact[],
	summary?: string,
	verification?: string,
): Todo {
	const now = nowIso();
	const todo: Todo = {
		id: freshId("t"),
		title: flattenTitle(decodeIfAgent(title, origin)),
		status,
		origin,
		createdAt: now,
		updatedAt: now,
	};
	if (note) todo.note = decodeIfAgent(note, origin);
	if (summary) todo.summary = decodeMarkdownIfAgent(summary, origin);
	if (verification) todo.verification = decodeMarkdownIfAgent(verification, origin);
	const clean = inputArtifacts(decodeArtifactsIfAgent(artifacts, origin));
	if (clean) todo.artifacts = clean;
	return todo;
}

export class TodoStore {
	readonly file: string;

	constructor(root: string, sessionId: string) {
		this.file = join(root, storeRel(sessionId));
	}

	read(): TodoPlan {
		let raw: string;
		try {
			raw = readFileSync(this.file, "utf8");
		} catch (error) {
			if (isMissingFile(error)) {
				refusedOverwrites.delete(this.file);
			} else if (!refusedOverwrites.has(this.file)) {
				refusedOverwrites.add(this.file);
				report("STATE_FILE_UNREADABLE", `${basename(this.file)}: could not be read`);
			}
			return emptyPlan();
		}
		const refusedBefore = refusedOverwrites.delete(this.file);
		const onDrop = () => keepCorruptCopy(this.file, raw, refusedBefore);
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			onDrop();
			return emptyPlan();
		}
		const stored = parseFieldwise(parsed, StoredFile, onDrop);
		if (!stored) {
			onDrop();
			return emptyPlan();
		}
		const plan: TodoPlan = {
			todos: keptEntries(stored.todos, (entry) => sanitize(entry, onDrop), onDrop),
			groups: keptEntries(stored.groups, (entry) => sanitizeGroup(entry, onDrop), onDrop),
		};
		if (stored.summary) plan.summary = stored.summary;
		return plan;
	}

	/**
	 * Set (or clear, with an empty string) the plan-level completion summary — the agent's overall
	 * handoff note, written when the whole plan is done (`todo_plan_summary`). Stored verbatim across
	 * later edits; display gating ("only while everything is done") is the reader's job.
	 */
	setSummary(summary: string): void {
		const plan = this.read();
		const text = decodeMarkdown(summary.trim());
		if (text) plan.summary = text;
		else delete plan.summary;
		this.write(plan);
	}

	flat(): Todo[] {
		return flatItems(this.read());
	}

	list(status?: TodoStatus): Todo[] {
		const all = this.flat();
		return status ? all.filter((t) => t.status === status) : all;
	}

	get(id: string): Todo | undefined {
		return this.flat().find((t) => t.id === id);
	}

	add(input: TodoInput): Todo {
		const todo = makeTodo(
			input.title,
			"pending",
			input.origin ?? "agent",
			input.note,
			input.artifacts,
		);
		const plan = this.read();
		if (input.after !== undefined) {
			const lane = [plan.todos, ...plan.groups.map((g) => g.todos)].find((items) =>
				items.some((t) => t.id === input.after),
			);
			if (!lane) throw new Error(`No TODO with id "${input.after}" to insert after.`);
			lane.splice(lane.findIndex((t) => t.id === input.after) + 1, 0, todo);
			this.write(plan);
			return todo;
		}
		const groupTitle = input.group ? flattenTitle(decodeUnicode(input.group)) : undefined;
		if (groupTitle) {
			let group = plan.groups.find((g) => g.title === groupTitle);
			if (!group) {
				group = { id: freshId("g"), title: groupTitle, todos: [] };
				plan.groups.push(group);
			}
			group.todos.push(todo);
		} else {
			plan.todos.push(todo);
		}
		this.write(plan);
		return todo;
	}

	private keepOneInProgress(plan: TodoPlan, keep?: string): Todo[] {
		const demoted: Todo[] = [];
		let kept = false;
		for (const item of flatItems(plan)) {
			if (item.status !== "in_progress") continue;
			if (item.id === keep || (keep === undefined && !kept)) {
				kept = true;
				continue;
			}
			item.status = "pending";
			item.updatedAt = nowIso();
			demoted.push(item);
		}
		return demoted;
	}

	update(id: string, patch: TodoPatch): TodoUpdateResult | undefined {
		const plan = this.read();
		const all = flatItems(plan);
		const todo = all.find((t) => t.id === id);
		if (!todo) return undefined;
		let paused: Todo[] = [];
		if (patch.title !== undefined)
			todo.title = flattenTitle(decodeIfAgent(patch.title, todo.origin));
		if (patch.status !== undefined) {
			const wasDone = todo.status === "done";
			todo.status = patch.status;
			if (patch.status === "in_progress") paused = this.keepOneInProgress(plan, id);
			if (wasDone && patch.status !== "done") {
				delete todo.summary;
				delete todo.verification;
				delete todo.commitSubject;
				// The plan-level summary is NOT dropped: it survives the re-open (stale) so the UI can show
				// it as "Updating…" and the next completion can EXTEND it (cumulative contract). Display/
				// export gating on "everything done" is the reader's job, not a disk erase.
			}
		}
		if (patch.note !== undefined) {
			if (patch.note) todo.note = decodeIfAgent(patch.note, todo.origin);
			else delete todo.note;
		}
		if (patch.summary !== undefined) {
			if (patch.summary) todo.summary = decodeMarkdownIfAgent(patch.summary, todo.origin);
			else delete todo.summary;
		}
		if (patch.verification !== undefined) {
			if (patch.verification)
				todo.verification = decodeMarkdownIfAgent(patch.verification, todo.origin);
			else delete todo.verification;
		}
		if (patch.commitSubject !== undefined) {
			if (patch.commitSubject) todo.commitSubject = decodeIfAgent(patch.commitSubject, todo.origin);
			else delete todo.commitSubject;
		}
		if (patch.artifacts !== undefined) {
			const clean = inputArtifacts(decodeArtifactsIfAgent(patch.artifacts, todo.origin));
			if (clean) todo.artifacts = clean;
			else delete todo.artifacts;
		}
		todo.updatedAt = nowIso();
		this.write(plan);
		return { todo, paused };
	}

	remove(id: string): boolean {
		const plan = this.read();
		const before = countItems(plan);
		plan.todos = plan.todos.filter((t) => t.id !== id);
		const prevCounts = new Map<string, number>();
		for (const group of plan.groups) prevCounts.set(group.id, group.todos.length);
		for (const group of plan.groups) group.todos = group.todos.filter((t) => t.id !== id);
		plan.groups = plan.groups.filter((group) => {
			if (group.todos.length > 0) return true;
			return (prevCounts.get(group.id) ?? 0) === 0;
		});
		if (countItems(plan) === before) return false;
		this.write(plan);
		return true;
	}

	promote(id: string, titleOverride?: string): TodoPromoteResult {
		const plan = this.read();
		const idx = plan.todos.findIndex((t) => t.id === id);
		const item = plan.todos[idx];
		if (!item) {
			const inGroup = plan.groups.some((g) => g.todos.some((t) => t.id === id));
			return { ok: false, reason: inGroup ? "grouped-step" : "unknown-id" };
		}
		const title = flattenTitle(
			titleOverride !== undefined ? decodeUnicode(titleOverride) : item.title,
		);
		if (!title) return { ok: false, reason: "empty-title" };
		if (plan.groups.some((g) => g.title === title)) return { ok: false, reason: "title-collision" };
		plan.todos.splice(idx, 1);
		const group: TodoGroup = { id: item.id, title, todos: [] };
		plan.groups.push(group);
		this.write(plan);
		return { ok: true, group };
	}

	replaceAll(plan: WritePlan): TodoPlan {
		const current = this.read();
		const existingByKey = new Map<string, Todo[]>();
		for (const g of current.groups) {
			for (const t of g.todos) {
				if (t.origin !== "agent") continue;
				const key = `${g.title}\u0000${t.title}`;
				const bucket = existingByKey.get(key);
				if (bucket) bucket.push(t);
				else existingByKey.set(key, [t]);
			}
		}
		const consumed = new Set<string>();
		const reconcile = (groupTitle: string, w: WriteItem): Todo => {
			const hit = existingByKey
				.get(`${groupTitle}\u0000${flattenTitle(decodeUnicode(w.title))}`)
				?.find((t) => !consumed.has(t.id));
			if (!hit) {
				return makeTodo(
					w.title,
					w.status ?? "pending",
					"agent",
					w.note,
					w.artifacts,
					w.summary,
					w.verification,
				);
			}
			consumed.add(hit.id);
			const merged: Todo = { ...hit };
			if (w.note !== undefined) {
				const note = decodeUnicode(w.note);
				if (note) merged.note = note;
				else delete merged.note;
				merged.updatedAt = nowIso();
			}
			return merged;
		};
		const freshGroups: TodoGroup[] = (plan.groups ?? []).map((g) => {
			const title = flattenTitle(decodeUnicode(g.title));
			return { id: freshId("g"), title, todos: g.todos.map((w) => reconcile(title, w)) };
		});
		const resultLoose = current.todos.filter((t) => t.origin === "user" || t.status !== "done");
		const carriedGroups: TodoGroup[] = [];
		for (const old of current.groups) {
			if (old.todos.length > 0) continue;
			if (freshGroups.some((g) => g.title === old.title)) continue;
			carriedGroups.push({ id: old.id, title: old.title, todos: [] });
		}
		const carriedLooseDone: Todo[] = [];
		for (const old of current.groups) {
			const carriedDone: Todo[] = [];
			for (const t of old.todos) {
				if (consumed.has(t.id)) continue;
				if (t.origin === "user") {
					resultLoose.push(t);
				} else if (t.status === "done") {
					const match = freshGroups.find((g) => g.title === old.title);
					if (match) match.todos.push(t);
					else carriedDone.push(t);
				}
			}
			if (carriedDone.length > 0) {
				carriedGroups.push({ id: freshId("g"), title: old.title, todos: carriedDone });
			}
		}
		for (const t of current.todos) {
			if (t.origin === "agent" && t.status === "done") carriedLooseDone.push(t);
		}
		if (carriedLooseDone.length > 0) {
			const match = freshGroups.find((g) => g.title === CARRIED_LOOSE_GROUP);
			if (match) match.todos.push(...carriedLooseDone);
			else
				carriedGroups.push({
					id: freshId("g"),
					title: CARRIED_LOOSE_GROUP,
					todos: carriedLooseDone,
				});
		}

		const next: TodoPlan = { todos: resultLoose, groups: [...freshGroups, ...carriedGroups] };
		this.keepOneInProgress(next);
		this.write(next);
		return next;
	}

	private write(plan: TodoPlan): void {
		if (refusedOverwrites.has(this.file)) {
			throw new TodoStoreError(`${basename(this.file)} could not be read, so it was not replaced`);
		}
		const file: TodoFile = {
			version: CURRENT_VERSION,
			todos: plan.todos,
			groups: plan.groups,
		};
		if (plan.summary) file.summary = plan.summary;
		mkdirSync(dirname(this.file), { recursive: true });
		const tmp = `${this.file}.${randomUUID().slice(0, 8)}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
		renameSync(tmp, this.file);
	}
}
