import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { RepoGraph } from "../core/types";
import { worktreePaths } from "../git";
import { indexRepo } from "../indexer/indexRepo";
import { parseSpec } from "../indexer/modules";
import { createFixtureRepo, type FixtureRepo } from "./fixture";

setDefaultTimeout(60_000);

let repo: FixtureRepo;
let graph: RepoGraph;

function symbol(id: string) {
	const found = graph.symbols.find((entry) => entry.id === id);
	if (!found) throw new Error(`Missing symbol ${id}`);
	return found;
}

function hasEdge(from: string, to: string, kind: string, label?: string) {
	return graph.edges.some(
		(edge) =>
			edge.from === from &&
			edge.to === to &&
			edge.kind === kind &&
			(label === undefined || edge.label === label),
	);
}

beforeAll(() => {
	repo = createFixtureRepo();
	const sha = repo.commit("init");
	graph = indexRepo({
		root: repo.root,
		paths: worktreePaths(repo.root),
		ref: { kind: "commit", sha },
		commits: new Map([["packages/server/src/format.ts", 3]]),
	});
});

afterAll(() => repo.dispose());

describe("symbols", () => {
	test("classifies every symbol kind", () => {
		expect(symbol("packages/server/src/format.ts#formatEcho").kind).toBe("function");
		expect(symbol("packages/web/src/App.tsx#PingCard").kind).toBe("component");
		expect(symbol("packages/web/src/App.tsx#Card").kind).toBe("component");
		expect(symbol("packages/web/src/App.tsx#Panel").kind).toBe("component");
		expect(symbol("packages/web/src/App.tsx#useThing").kind).toBe("hook");
		expect(symbol("packages/web/src/transport.ts#WsTransport").kind).toBe("class");
		expect(symbol("packages/web/src/transport.ts#WsTransport.request").kind).toBe("method");
		expect(symbol("packages/web/src/clock.ts#Clock").kind).toBe("interface");
		expect(symbol("packages/web/src/clock.ts#Clock.now").kind).toBe("method");
		expect(symbol("packages/web/src/clock.ts#Clock.label").kind).toBe("method");
		expect(symbol("packages/contracts/src/index.ts#WsMethodName").kind).toBe("type");
		expect(symbol("packages/contracts/src/index.ts#WS_CHANNELS").kind).toBe("const");
		expect(symbol("packages/web/src/store.ts#useStore").kind).toBe("hook");
		expect(symbol("packages/web/src/store.ts#useStore.bump").kind).toBe("method");
		expect(symbol("packages/server/src/handlers.ts#handlers.sys.echo").kind).toBe("wire-handler");
		expect(symbol("packages/server/src/tools.ts#registerPing.ping_tool").kind).toBe("tool");
	});

	test("marks tests, exports and barrel exports", () => {
		expect(symbol("packages/web/src/api.test.ts#pingSmoke").isTest).toBe(true);
		const ping = symbol("packages/web/src/api.ts#ping");
		expect(ping.exported).toBe(true);
		expect(ping.barrelExported).toBe(true);
		const lockName = symbol("packages/web/src/api.ts#lockName");
		expect(lockName.exported).toBe(true);
		expect(lockName.barrelExported).toBe(false);
		expect(symbol("packages/web/src/api.ts#send").exported).toBe(false);
		expect(symbol("packages/ui/button.tsx#Button").barrelExported).toBe(true);
	});

	test("prints signatures with inferred returns for exports", () => {
		expect(symbol("packages/server/src/format.ts#formatEcho").signature).toBe(
			"(text: string): string",
		);
		expect(symbol("packages/web/src/clock.ts#Clock").signature).toContain("now(): number");
	});

	test("rolls anonymous callbacks into the named symbol", () => {
		expect(hasEdge("packages/web/src/App.tsx#Card", "packages/web/src/api.ts#ping", "call")).toBe(
			true,
		);
	});
});

describe("edges", () => {
	test("resolves workspace subpaths and tsconfig paths", () => {
		expect(
			hasEdge("packages/web/src/App.tsx#Card", "packages/ui/button.tsx#Button", "render"),
		).toBe(true);
		expect(graph.files.find((file) => file.path === "packages/web/src/App.tsx")?.imports).toContain(
			"packages/web/src/api.ts",
		);
	});

	test("records new, render, type-ref and value references", () => {
		expect(
			hasEdge(
				"packages/web/src/transport.ts#getTransport",
				"packages/web/src/transport.ts#WsTransport",
				"new",
			),
		).toBe(true);
		expect(
			hasEdge("packages/web/src/App.tsx#PingCard", "packages/web/src/App.tsx#Card", "render"),
		).toBe(true);
		expect(
			hasEdge(
				"packages/web/src/transport.ts#WsTransport.request",
				"packages/contracts/src/index.ts#WsMethodName",
				"type-ref",
			),
		).toBe(true);
		expect(
			hasEdge("packages/web/src/App.tsx#Panel", "packages/web/src/Panel.tsx#Panel", "call"),
		).toBe(true);
	});

	test("resolves interface calls to the member and links implementers", () => {
		expect(
			hasEdge("packages/web/src/clock.ts#readClock", "packages/web/src/clock.ts#Clock.now", "call"),
		).toBe(true);
		expect(
			hasEdge(
				"packages/web/src/clock.ts#SystemClock",
				"packages/web/src/clock.ts#Clock",
				"implements",
			),
		).toBe(true);
		expect(
			hasEdge(
				"packages/web/src/clock.ts#SystemClock.now",
				"packages/web/src/clock.ts#Clock.now",
				"implements",
			),
		).toBe(true);
		expect(
			hasEdge(
				"packages/web/src/clock.ts#fixedClock.now",
				"packages/web/src/clock.ts#Clock.now",
				"implements",
			),
		).toBe(true);
	});

	test("treats a global augmentation of a lib type as external", () => {
		expect(
			graph.edges.some(
				(edge) => edge.from === "packages/web/src/globals.ts#hostOf" && edge.kind === "type-ref",
			),
		).toBe(false);
	});

	test("reports call site totals", () => {
		const { stats } = graph;
		expect(stats.callSites).toBe(
			stats.resolvedInRepo + stats.resolvedExternal + stats.unresolved + stats.dynamicCalls,
		);
		expect(stats.resolvedInRepo).toBeGreaterThan(5);
		expect(stats.files).toBe(graph.files.length);
	});

	test("dedupes edges with a count", () => {
		const repeated = graph.edges.filter(
			(edge) => edge.from === "packages/web/src/api.ts#either" && edge.kind === "call",
		);
		expect(new Set(repeated.map((edge) => edge.to)).size).toBe(repeated.length);
	});
});

describe("modules", () => {
	test("uses SPEC.md and package roots", () => {
		const contracts = graph.modules.find((module) => module.path === "packages/contracts");
		expect(contracts?.title).toBe("Fixture contracts");
		expect(contracts?.responsibility).toBe("The wire types of the fixture.");
		expect(symbol("packages/web/src/api.ts#ping").module).toBe("packages/web");
		expect(graph.moduleEdges).toContainEqual({
			from: "packages/web",
			to: "packages/ui",
			imports: 1,
		});
		expect(graph.files.find((file) => file.path.endsWith("format.ts"))?.commits90d).toBe(3);
	});

	test("reads a multi-line responsibility", () => {
		const text = "---\ntitle: T\n---\n\n## Responsibility\n\nOne line\nkept going. Next.\n\n## B\n";
		expect(parseSpec(text)).toEqual({ title: "T", responsibility: "One line kept going." });
	});
});
