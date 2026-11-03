import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { diffGraphs } from "../core/diff";
import type { ChangeGroup, GraphDiff, RepoGraph, SymbolChange } from "../core/types";
import { loadGraph } from "../graphs";
import { BASE_FILES, createFixtureRepo, type FixtureRepo, symbolId } from "./fixture";

setDefaultTimeout(60_000);

let repo: FixtureRepo;
let base: RepoGraph;
let head: RepoGraph;
let diff: GraphDiff;

function fixtureFile(path: string) {
	const text = BASE_FILES[path];
	if (text === undefined) throw new Error(`Missing fixture file ${path}`);
	return text;
}

function allChanges() {
	return diff.groups.flatMap((group) => group.symbolChanges);
}

function changeOf(id: string) {
	return allChanges().find(
		(change: SymbolChange) =>
			("head" in change && change.head === id) || ("base" in change && change.base === id),
	);
}

function groupOf(id: string): ChangeGroup {
	const found = diff.groups.find((group) =>
		group.symbolChanges.some(
			(change) =>
				("head" in change && change.head === id) || ("base" in change && change.base === id),
		),
	);
	if (!found) throw new Error(`No group holds ${id}`);
	return found;
}

beforeAll(() => {
	repo = createFixtureRepo();
	const baseSha = repo.commit("base");
	repo.write({
		"packages/server/src/format.ts": `export function formatEcho(text: string) {
	return text.trim().toLowerCase();
}
`,
		"packages/server/src/moved.ts": `export function unusedHelper(a: number) {
	const doubled = a * 2;
	const tripled = a * 3;
	return doubled + tripled;
}
`,
		"packages/web/src/clock.ts": `// a new comment
export interface Clock {
	now(): number
	label: () => string
}

export class SystemClock implements Clock {
	now() { return Date.now() }
	label = () => 'system'
}

export const fixedClock: Clock = { now: () => 1, label: () => 'fixed', };

export function readClock(clock: Clock) { return clock.now() }
`,
		"packages/web/src/api.ts": fixtureFile("packages/web/src/api.ts")
			.replace(
				"export function ping() {",
				"export function ping(timeoutMs: number) {\n\tconsole.log(timeoutMs);",
			)
			.replace('export function lockName() {\n\treturn fakeLocks.request("sys.orphan");\n}\n', ""),
		"packages/web/src/index.ts": `export { echo, ping, either } from "./api";
`,
		"packages/web/src/added.ts": "export function brandNew() {\n\treturn 1;\n}\n",
		"packages/web/src/App.tsx": fixtureFile("packages/web/src/App.tsx").replace(
			"onClick={() => ping()}",
			"onClick={() => ping(1)}",
		),
		"packages/web/src/api.test.ts": fixtureFile("packages/web/src/api.test.ts").replace(
			"ping()",
			"ping(1)",
		),
		"packages/server/src/handlers.ts": fixtureFile("packages/server/src/handlers.ts").replace(
			'"sys.orphan": () => null,',
			'"sys.orphan": () => undefined,',
		),
		"README.md": "changed\n",
	});
	const headSha = repo.commit("head");
	base = loadGraph({
		root: repo.root,
		target: { kind: "commit", sha: baseSha },
		refresh: true,
	}).graph;
	head = loadGraph({
		root: repo.root,
		target: { kind: "commit", sha: headSha },
		refresh: true,
	}).graph;
	diff = diffGraphs({ base, head, nonCodeFiles: ["README.md"] });
});

afterAll(() => repo.dispose());

describe("classification", () => {
	test("modified when the body changes", () => {
		expect(changeOf("packages/server/src/format.ts#formatEcho")).toMatchObject({
			kind: "modified",
			signatureChanged: false,
		});
	});

	test("modified with a signature change", () => {
		expect(changeOf("packages/web/src/api.ts#ping")).toMatchObject({
			kind: "modified",
			signatureChanged: true,
		});
	});

	test("added and removed", () => {
		expect(changeOf("packages/web/src/added.ts#brandNew")?.kind).toBe("added");
		expect(changeOf("packages/web/src/api.ts#lockName")?.kind).toBe("removed");
	});

	test("moved when the body stays and the id changes", () => {
		expect(diff.movedOnly).toContainEqual({
			kind: "moved",
			base: symbolId("packages/server/src/format.ts#unusedHelper"),
			head: symbolId("packages/server/src/moved.ts#unusedHelper"),
		});
		expect(changeOf("packages/server/src/moved.ts#unusedHelper")).toBeUndefined();
	});

	test("reformatting and comments are format-only", () => {
		expect(diff.formatOnlyFiles).toEqual(["packages/web/src/clock.ts"]);
		expect(changeOf("packages/web/src/clock.ts#SystemClock.now")).toBeUndefined();
		expect(diff.changedFiles).toContain("packages/web/src/clock.ts");
		expect(diff.nonCodeFiles).toEqual(["README.md"]);
	});
});

describe("groups and blast radius", () => {
	test("groups changed symbols over call edges", () => {
		const group = groupOf("packages/web/src/api.ts#ping");
		const ids = group.symbolChanges.map((change) => ("head" in change ? change.head : change.base));
		expect(ids).toContain(symbolId("packages/web/src/App.tsx#Card"));
		expect(ids).toContain(symbolId("packages/web/src/api.test.ts#pingSmoke"));
		expect(ids).not.toContain(symbolId("packages/server/src/format.ts#formatEcho"));
	});

	test("orders groups by size", () => {
		const sizes = diff.groups.map((group) => group.symbolChanges.length);
		expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
	});

	test("titles a group from the highest changed symbol", () => {
		expect(groupOf("packages/web/src/api.ts#ping").title).toBe("Card");
		expect(groupOf("packages/server/src/format.ts#formatEcho").title).toBe("formatEcho");
	});

	test("blast crosses the wire to callers, entry points and tests", () => {
		const { blast } = groupOf("packages/server/src/format.ts#formatEcho");
		expect(blast.callers).toContain(symbolId("packages/server/src/handlers.ts#handlers.sys.echo"));
		expect(blast.callers).toContain(symbolId("packages/web/src/api.ts#echo"));
		expect(blast.entryPoints).toContain(
			symbolId("packages/server/src/handlers.ts#handlers.sys.echo"),
		);
		expect(blast.entryPoints).toContain(
			symbolId("packages/server/src/tools.ts#registerPing.ping_tool"),
		);
		expect(blast.tests).toEqual([symbolId("packages/web/src/api.test.ts#echoSmoke")]);
		expect(blast.truncated).toBe(false);
	});

	test("a change with no callers has an empty blast", () => {
		const { blast } = groupOf("packages/server/src/handlers.ts#handlers.sys.orphan");
		expect(blast.callers).toEqual([]);
	});

	test("blast of a removal uses the base graph", () => {
		const { blast } = groupOf("packages/web/src/api.ts#lockName");
		expect(blast.tests).toContain(symbolId("packages/web/src/api.test.ts#lockSmoke"));
	});

	test("sets truncated when the bound is hit", () => {
		const bounded = diffGraphs({ base, head, blastLimit: 1 });
		expect(bounded.groups.some((group) => group.blast.truncated)).toBe(true);
	});
});

describe("contracts", () => {
	test("lists barrel exports and signature changes", () => {
		expect(diff.contracts).toContainEqual(
			expect.objectContaining({
				kind: "signature-changed",
				symbol: symbolId("packages/web/src/api.ts#ping"),
				before: expect.stringContaining("()"),
				after: expect.stringContaining("timeoutMs"),
			}),
		);
		expect(diff.contracts).toContainEqual({
			kind: "export-added",
			symbol: symbolId("packages/web/src/api.ts#either"),
		});
	});

	test("lists wire methods and module dependencies", () => {
		const added = createFixtureRepo();
		const firstSha = added.commit("first");
		added.write({
			"packages/server/src/handlers.ts": fixtureFile("packages/server/src/handlers.ts").replace(
				'"sys.orphan": () => null,',
				"",
			),
			"packages/contracts/src/index.ts": fixtureFile("packages/contracts/src/index.ts").replace(
				'orphan: "sys.orphan",',
				"",
			),
			"packages/server/src/format.ts": `import { Button } from "@fx/ui/button";

export const held = Button;
${fixtureFile("packages/server/src/format.ts")}`,
		});
		const secondSha = added.commit("second");
		const before = loadGraph({
			root: added.root,
			target: { kind: "commit", sha: firstSha },
			refresh: true,
		}).graph;
		const after = loadGraph({
			root: added.root,
			target: { kind: "commit", sha: secondSha },
			refresh: true,
		}).graph;
		added.dispose();
		const contracts = diffGraphs({ base: before, head: after }).contracts;
		expect(contracts).toContainEqual({ kind: "wire-method-removed", method: "sys.orphan" });
		expect(contracts).toContainEqual({
			kind: "module-dependency-added",
			from: "packages/server",
			to: "packages/ui",
		});
	});
});
