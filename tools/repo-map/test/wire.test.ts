import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { RepoGraph } from "../core/types";
import { worktreePaths } from "../git";
import { indexRepo } from "../indexer/indexRepo";
import { createFixtureRepo, type FixtureRepo, symbolId } from "./fixture";

setDefaultTimeout(60_000);

let repo: FixtureRepo;
let graph: RepoGraph;

function wireEdges(kind: string, label: string) {
	return graph.edges.filter((edge) => edge.kind === kind && edge.label === label);
}

beforeAll(() => {
	repo = createFixtureRepo();
	const sha = repo.commit("init");
	graph = indexRepo({
		root: repo.root,
		paths: worktreePaths(repo.root),
		ref: { kind: "commit", sha },
		commits: new Map(),
	});
});

afterAll(() => repo.dispose());

describe("wire-request", () => {
	test("links a literal request to the handler entry", () => {
		const edges = wireEdges("wire-request", "sys.ping");
		expect(edges.map((edge) => edge.from)).toContain(symbolId("packages/web/src/api.ts#ping"));
		expect(edges[0]?.to).toBe(symbolId("packages/server/src/handlers.ts#handlers.sys.ping"));
	});

	test("follows wrappers to literal callers", () => {
		const edges = wireEdges("wire-request", "sys.echo");
		expect(edges.map((edge) => edge.from)).toContain(symbolId("packages/web/src/api.ts#echo"));
		expect(edges.map((edge) => edge.from)).not.toContain(symbolId("packages/web/src/api.ts#send"));
	});

	test("resolves a literal union from a local const", () => {
		for (const method of ["sys.ping", "sys.echo"]) {
			expect(wireEdges("wire-request", method).map((edge) => edge.from)).toContain(
				symbolId("packages/web/src/api.ts#either"),
			);
		}
	});

	test("ignores request on other receivers", () => {
		expect(wireEdges("wire-request", "sys.orphan")).toEqual([]);
	});

	test("counts coverage honestly", () => {
		expect(graph.stats.wireMethods).toBe(3);
		expect(graph.stats.wireMethodsWithHandler).toBe(3);
		expect(graph.stats.wireMethodsWithCaller).toBe(2);
		expect(graph.stats.wireDynamicRequests).toBe(1);
		expect(graph.stats.wireUnhandledRequests).toBe(0);
	});
});

describe("wire-push", () => {
	test("links publisher to subscriber and skips socket subscribe", () => {
		const edges = wireEdges("wire-push", "sys.tick");
		expect(edges).toHaveLength(1);
		expect(edges[0]?.from).toBe(symbolId("packages/server/src/publish.ts#publishTick"));
		expect(edges[0]?.to).toBe(symbolId("packages/web/src/subscribe.ts#listenTick"));
		expect(wireEdges("wire-push", "sys.silent")).toEqual([]);
		expect(graph.stats.wireChannels).toBe(2);
		expect(graph.stats.wireChannelsLinked).toBe(1);
	});
});

describe("tool-render", () => {
	test("links a tool definition to the renderer", () => {
		const edges = wireEdges("tool-render", "ping_tool");
		expect(edges).toHaveLength(1);
		expect(edges[0]?.from).toBe(symbolId("packages/server/src/tools.ts#registerPing.ping_tool"));
		expect(edges[0]?.to).toBe(symbolId("packages/web/src/App.tsx#PingCard"));
		expect(graph.stats.tools).toBe(2);
		expect(graph.stats.toolsLinked).toBe(1);
		expect(graph.stats.toolRenderers).toBe(3);
	});
});

describe("repo without a wire", () => {
	test("produces no wire edges and does not fail", () => {
		const plain = createFixtureRepo({
			"package.json": JSON.stringify({ name: "plain" }),
			"a.ts": "export function a() {\n\treturn 1;\n}\n",
		});
		const sha = plain.commit("init");
		const result = indexRepo({
			root: plain.root,
			paths: worktreePaths(plain.root),
			ref: { kind: "commit", sha },
			commits: new Map(),
		});
		plain.dispose();
		expect(result.symbols.map((entry) => entry.id)).toEqual([symbolId("a.ts#a")]);
		expect(result.stats.wireMethods).toBe(0);
		expect(result.stats.tools).toBe(0);
	});
});
