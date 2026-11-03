import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkoutCommit } from "../checkout";
import { commonDir } from "../git";
import { loadGraph } from "../graphs";
import { createFixtureRepo, type FixtureRepo, symbolId } from "./fixture";

setDefaultTimeout(60_000);

let repo: FixtureRepo;
let baseSha: string;

beforeAll(() => {
	repo = createFixtureRepo();
	baseSha = repo.commit("base");
	repo.write({
		"packages/ui/button.tsx": `export function Button() {
	return <button />;
}

export function freshLabel() {
	return "fresh";
}
`,
		"packages/web/src/App.tsx": `import { Button, freshLabel } from "@fx/ui/button";

export function PingCard() {
	return (
		<div>
			<Button />
			{freshLabel()}
		</div>
	);
}
`,
	});
	repo.commit("head");
});

afterAll(() => repo.dispose());

describe("commit checkout", () => {
	test("reads the commit's workspace packages, not the symlinked live checkout", () => {
		const { graph } = loadGraph({
			root: repo.root,
			target: { kind: "commit", sha: baseSha },
			refresh: true,
		});
		expect(graph.ref).toEqual({ kind: "commit", sha: baseSha });
		expect(graph.symbols.map((symbol) => symbol.id)).toContain(
			symbolId("packages/ui/button.tsx#legacyLabel"),
		);
		expect(graph.symbols.map((symbol) => symbol.id)).not.toContain(
			symbolId("packages/ui/button.tsx#freshLabel"),
		);
		expect(
			graph.edges.some(
				(edge) =>
					edge.from === "packages/web/src/App.tsx#Card" &&
					edge.to === "packages/ui/button.tsx#legacyLabel" &&
					edge.kind === "call",
			),
		).toBe(true);
		expect(
			graph.edges.some(
				(edge) =>
					edge.from === "packages/web/src/App.tsx#Card" &&
					edge.to === "packages/ui/button.tsx#Button" &&
					edge.kind === "render",
			),
		).toBe(true);
	});

	test("links node_modules and removes the temp dir without touching the target", () => {
		const cacheDir = join(commonDir(repo.root), "repo-map");
		const checkout = checkoutCommit({ repo: repo.root, cacheDir, sha: baseSha });
		expect(lstatSync(join(checkout.root, "node_modules")).isSymbolicLink()).toBe(true);
		expect(existsSync(join(checkout.root, "packages/server/src/format.ts"))).toBe(true);
		checkout.cleanup();
		expect(existsSync(checkout.root)).toBe(false);
		expect(existsSync(join(repo.root, "node_modules/@fx/ui"))).toBe(true);
		expect(readdirSync(cacheDir).filter((entry) => entry.startsWith("tmp-"))).toEqual([]);
	});
});

describe("cache", () => {
	test("caches clean commits by sha", () => {
		const first = loadGraph({
			root: repo.root,
			target: { kind: "commit", sha: baseSha },
			refresh: false,
		});
		const second = loadGraph({
			root: repo.root,
			target: { kind: "commit", sha: baseSha },
			refresh: false,
		});
		expect(second.cached).toBe(true);
		expect(second.graph.symbols).toEqual(first.graph.symbols);
	});

	test("never caches a dirty working tree", () => {
		const clean = loadGraph({ root: repo.root, target: { kind: "worktree" }, refresh: true });
		expect(clean.graph.ref.kind).toBe("worktree");
		repo.write({ "packages/web/src/dirty.ts": "export const dirty = 1;\n" });
		const dirty = loadGraph({ root: repo.root, target: { kind: "worktree" }, refresh: false });
		expect(dirty.cached).toBe(false);
		expect(dirty.graph.ref).toMatchObject({
			kind: "worktree",
			dirtyFiles: ["packages/web/src/dirty.ts"],
		});
		expect(dirty.graph.symbols.map((symbol) => symbol.id)).toContain(
			symbolId("packages/web/src/dirty.ts#dirty"),
		);
		repo.remove("packages/web/src/dirty.ts");
		const again = loadGraph({ root: repo.root, target: { kind: "worktree" }, refresh: false });
		expect(again.cached).toBe(true);
		expect(again.graph.symbols.map((symbol) => symbol.id)).not.toContain(
			symbolId("packages/web/src/dirty.ts#dirty"),
		);
	});
});
