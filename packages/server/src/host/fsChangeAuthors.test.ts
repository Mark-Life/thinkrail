import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceFsChangedPayload } from "@thinkrail/contracts";
import { hashBytes } from "../fs";
import { createProvenance } from "../provenance";
import { withFsChangeAuthors } from "./fsChangeAuthors";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "trpi-fs-authors-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const frame = (paths: string[], truncated = false): WorkspaceFsChangedPayload => ({
	workspaceId: "ws",
	paths,
	truncated,
	skillChange: "none",
});

test("fsChanged carries the author of each changed path the ledger knows", () => {
	const provenance = createProvenance();
	const content = new TextEncoder().encode("agent\n");
	writeFileSync(join(dir, "a.ts"), content);
	writeFileSync(join(dir, "b.ts"), "nobody\n");
	provenance.recordWrite({
		path: join(dir, "a.ts"),
		author: { kind: "agent", sessionId: "s1", via: "tool", toolName: "write" },
		before: null,
		after: content,
	});

	const payload = withFsChangeAuthors(frame(["a.ts", "b.ts", "../out.ts"]), {
		provenance,
		root: () => dir,
	});
	expect(payload.authors).toEqual({
		"a.ts": {
			author: { kind: "agent", sessionId: "s1", via: "tool", toolName: "write" },
			hash: hashBytes(content),
		},
	});
});

test("a frame with no known author, a truncated frame and a pathless frame stay as they were", () => {
	const provenance = createProvenance();
	const root = () => dir;
	writeFileSync(join(dir, "a.ts"), "x\n");
	const plain = frame(["a.ts"]);
	expect(withFsChangeAuthors(plain, { provenance, root })).toBe(plain);
	const truncated = frame(["a.ts"], true);
	expect(withFsChangeAuthors(truncated, { provenance, root })).toBe(truncated);
	const pathless = frame([]);
	expect(withFsChangeAuthors(pathless, { provenance, root })).toBe(pathless);
});

test("a path held back by an agent claim is sent again as an authors-only frame", async () => {
	const provenance = createProvenance();
	const path = join(dir, "a.ts");
	const agent = { kind: "agent", sessionId: "s1", via: "tool", toolName: "edit" } as const;
	provenance.openClaim({ sessionId: "s1", toolCallId: "t1", path, mutates: true, hash: null });
	const content = new TextEncoder().encode("agent\n");
	writeFileSync(path, content);
	const republished: WorkspaceFsChangedPayload[] = [];
	const options = {
		provenance,
		root: () => dir,
		republish: (payload: WorkspaceFsChangedPayload) => republished.push(payload),
	};
	expect(withFsChangeAuthors(frame(["a.ts"]), options).authors).toBeUndefined();

	provenance.recordWrite({ path, author: agent, before: null, after: content, toolCallId: "t1" });
	provenance.endTool({ sessionId: "s1", toolCallId: "t1" });
	await Promise.resolve();
	expect(republished).toEqual([
		{
			...frame(["a.ts"]),
			authorsOnly: true,
			authors: { "a.ts": { author: agent, hash: hashBytes(content) } },
		},
	]);
});

test("a held path whose claim ends with no write sends nothing", async () => {
	const provenance = createProvenance();
	const path = join(dir, "a.ts");
	writeFileSync(path, "x\n");
	provenance.openClaim({ sessionId: "s1", toolCallId: "t1", path, mutates: true, hash: null });
	const republished: WorkspaceFsChangedPayload[] = [];
	withFsChangeAuthors(frame(["a.ts"]), {
		provenance,
		root: () => dir,
		republish: (payload) => republished.push(payload),
	});
	provenance.endTool({ sessionId: "s1", toolCallId: "t1" });
	provenance.forgetSession("s1");
	await Promise.resolve();
	expect(republished).toEqual([]);
});

test("a root file whose name starts with two dots gets an author; a parent path does not", () => {
	const write = { author: { kind: "external" }, hash: "h" } as const;
	const payload = withFsChangeAuthors(frame(["..env", "...config", "..", "../x", "a.ts"]), {
		provenance: { changeWrite: () => write },
		root: () => "/r",
	});
	expect(payload.authors).toEqual({ "..env": write, "...config": write, "a.ts": write });
});
