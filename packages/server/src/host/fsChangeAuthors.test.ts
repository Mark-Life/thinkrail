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
	const resolve = (_workspaceId: string, path: string) => join(dir, path);
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
		resolve: (workspaceId, path) => (path.startsWith("..") ? null : resolve(workspaceId, path)),
	});
	expect(payload.authors).toEqual({
		"a.ts": {
			author: { kind: "agent", sessionId: "s1", via: "tool", toolName: "write" },
			at: expect.any(Number),
			hash: hashBytes(content),
		},
	});
});

test("a frame with no known author, a truncated frame and a pathless frame stay as they were", () => {
	const provenance = createProvenance();
	const resolve = (_workspaceId: string, path: string) => join(dir, path);
	writeFileSync(join(dir, "a.ts"), "x\n");
	const plain = frame(["a.ts"]);
	expect(withFsChangeAuthors(plain, { provenance, resolve })).toBe(plain);
	const truncated = frame(["a.ts"], true);
	expect(withFsChangeAuthors(truncated, { provenance, resolve })).toBe(truncated);
	const pathless = frame([]);
	expect(withFsChangeAuthors(pathless, { provenance, resolve })).toBe(pathless);
});
