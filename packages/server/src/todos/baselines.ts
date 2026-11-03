import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	arr,
	bool,
	compile,
	map,
	nullable,
	obj,
	opt,
	type Static,
	str,
	unknown,
} from "@earendil-works/pi-schema";
import type { SessionId } from "@thinkrail/contracts";
import { parseSessionId } from "@thinkrail/contracts";
import { WORKSPACE_TODOS_DIR } from "@thinkrail/shared/paths";
import { assertOverwriteAllowed, parseEntryRecord, readStateFile } from "../persistence";

const BASELINE_SUFFIX = ".baselines.json";

const BaselineSchema = obj(
	{ paths: arr(str()), head: nullable(str()), shared: opt(bool()) },
	{ open: true },
);
export type Baseline = Static<typeof BaselineSchema>;

const BaselineEntry = compile(BaselineSchema);
const StoredBaselines = compile(obj({ items: opt(map(unknown())) }, { open: true }));

interface BaselineFile {
	version: 1;
	items: Record<string, Baseline>;
}

function baselinePath(root: string, sessionId: SessionId): string {
	return join(root, WORKSPACE_TODOS_DIR, `${sessionId}${BASELINE_SUFFIX}`);
}

export function readBaselines(root: string, sessionId: SessionId): Record<string, Baseline> {
	const file = readStateFile(baselinePath(root, sessionId));
	if (file.value === undefined) return {};
	if (StoredBaselines.check(file.value))
		return parseEntryRecord(file, file.value.items ?? {}, BaselineEntry);
	file.setAside("not a baselines file");
	return {};
}

export function otherSessionWindows(root: string, sessionId: SessionId): boolean {
	return otherOwners(root, sessionId).some(
		(owner) => Object.keys(readBaselines(root, owner)).length > 0,
	);
}

export function markOtherSessionWindowsShared(root: string, sessionId: SessionId): void {
	for (const owner of otherOwners(root, sessionId)) {
		const items = readBaselines(root, owner);
		const open = Object.values(items);
		if (open.length === 0 || open.every((b) => b.shared)) continue;
		for (const baseline of open) baseline.shared = true;
		try {
			writeBaselines(root, owner, items);
		} catch {}
	}
}

function otherOwners(root: string, sessionId: SessionId): SessionId[] {
	try {
		return readdirSync(join(root, WORKSPACE_TODOS_DIR))
			.filter((n) => n.endsWith(BASELINE_SUFFIX))
			.flatMap((n) => {
				const owner = parseSessionId(n.slice(0, -BASELINE_SUFFIX.length));
				return owner === null || owner === sessionId ? [] : [owner];
			});
	} catch {
		return [];
	}
}

export function dropItemBaseline(root: string, sessionId: SessionId, id: string): void {
	const items = readBaselines(root, sessionId);
	if (items[id] === undefined) return;
	delete items[id];
	writeBaselines(root, sessionId, items);
}

export function removeSessionBaselines(root: string, sessionId: SessionId): void {
	try {
		rmSync(baselinePath(root, sessionId), { force: true });
	} catch {}
}

export function writeBaselines(
	root: string,
	sessionId: SessionId,
	items: Record<string, Baseline>,
): void {
	const path = baselinePath(root, sessionId);
	assertOverwriteAllowed(path);
	if (Object.keys(items).length === 0) {
		rmSync(path, { force: true });
		return;
	}
	const file: BaselineFile = { version: 1, items };
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(file, null, "\t")}\n`, "utf8");
	renameSync(tmp, path);
}
