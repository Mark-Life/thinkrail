import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chunkIds, hashMask, initialFiles, type Manifest } from "./bundleManifest";
import { renderSuite } from "./report";
import { summarizeMetrics } from "./stats";
import { measureBundle } from "./suiteBundle";

const FIXTURES = join(import.meta.dir, "fixtures", "bundle");
const root = mkdtempSync(join(tmpdir(), "perf-compare-bundle-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function loadManifest(side: "base" | "head"): Manifest {
	return JSON.parse(readFileSync(join(FIXTURES, `${side}.manifest.json`), "utf8")) as Manifest;
}

function writeDist(side: "base" | "head", sizes: (file: string) => number) {
	const manifest = loadManifest(side);
	const dist = join(root, side);
	const files = Object.values(manifest).flatMap((chunk) => [
		chunk.file,
		...(chunk.css ?? []),
		...(chunk.assets ?? []),
	]);
	for (const file of new Set(files)) {
		mkdirSync(dirname(join(dist, file)), { recursive: true });
		const word = `${file.split("/").pop()?.split("-")[0]};`;
		writeFileSync(join(dist, file), word.repeat(sizes(file)).slice(0, sizes(file)));
	}
	mkdirSync(join(dist, ".vite"), { recursive: true });
	writeFileSync(join(dist, ".vite", "manifest.json"), JSON.stringify(manifest));
	writeFileSync(join(dist, "index.html"), "<!doctype html>");
	return dist;
}

const baseDist = writeDist("base", () => 1000);
const headDist = writeDist("head", (file) => (file.includes("chapel") ? 1500 : 1000));

test("chunk ids drop content hashes and the bun store path", () => {
	const ids = [...chunkIds(loadManifest("base")).values()];
	expect(ids).toContain("_chunk.js");
	expect(ids).toContain("_dist.js");
	expect(ids).toContain("node_modules/@shikijs/langs/dist/cpp.mjs");
	expect(ids).toContain(
		"node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2",
	);
	expect(new Set(ids).size).toBe(ids.length);
});

test("duplicate shared chunk names are split by their first importer", () => {
	const ids = chunkIds(loadManifest("base"));
	expect(ids.get("_c-BvoqrSVH.js")).toBe("_c.js (from index.html)");
	expect(ids.get("_c-BEiaufqY.js")).toBe(
		"_c.js (from node_modules/@shikijs/langs/dist/chapel.mjs)",
	);
});

test("the same source package in two versions gets a version suffix", () => {
	const manifest: Manifest = {
		"../../node_modules/.bun/a@1.0.0/node_modules/a/x.js": { file: "assets/x-1.js" },
		"../../node_modules/.bun/a@2.0.0/node_modules/a/x.js": { file: "assets/x-2.js" },
	};
	expect([...chunkIds(manifest).values()].sort()).toEqual([
		"node_modules/a/x.js (v1.0.0)",
		"node_modules/a/x.js (v2.0.0)",
	]);
});

test("ids match across sides after a rebuild changes every hash", () => {
	const base = new Set(chunkIds(loadManifest("base")).values());
	const head = new Set(chunkIds(loadManifest("head")).values());
	expect([...base].filter((id) => !head.has(id))).toEqual(["src/panels/PlanPane.tsx"]);
	expect([...head].filter((id) => !base.has(id))).toEqual(["src/panels/FilesPane.tsx"]);
});

test("initial files follow static imports from entries only", () => {
	expect(initialFiles(loadManifest("base"))).toEqual({
		js: ["assets/index-MaoJkJi8.js", "assets/chunk-QTnfLwEv.js"],
		css: ["assets/index-D8ugW8tW.css"],
	});
});

test("measureBundle reports raw, gzip and brotli sizes per chunk and totals", async () => {
	const byId = new Map((await measureBundle(baseDist)).map((m) => [m.id, m]));
	expect(byId.get("bundle/initial-js/raw")?.value).toBe(2000);
	expect(byId.get("bundle/initial-css/raw")?.value).toBe(1000);
	expect(byId.get("bundle/total/js/raw")?.value).toBe(8000);
	expect(byId.get("bundle/total/woff2/raw")?.value).toBe(1000);
	expect(byId.get("bundle/dist")?.value).toBe(10000 + "<!doctype html>".length);
	expect(byId.get("bundle/files")).toMatchObject({ value: 10, unit: "count" });
	expect(byId.get("bundle/js-chunks")?.value).toBe(8);
	expect(byId.get("bundle/css/index.html/raw")?.value).toBe(1000);
	expect(
		byId.get(
			"bundle/asset/node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2",
		)?.value,
	).toBe(1000);
	const gzip = byId.get("bundle/chunk/_dist.js/gzip")?.value ?? 0;
	const brotli = byId.get("bundle/chunk/_dist.js/brotli")?.value ?? 0;
	expect(gzip).toBeGreaterThan(0);
	expect(gzip).toBeLessThan(100);
	expect(brotli).toBeGreaterThan(0);
	expect([...byId.values()].every((m) => m.kind === "exact")).toBe(true);
});

test("a base/head compare shows added, removed and changed chunks with exact deltas", async () => {
	const metrics = summarizeMetrics({
		base: await measureBundle(baseDist),
		head: await measureBundle(headDist),
		threshold: 0,
	});
	const byId = new Map(metrics.map((m) => [m.id, m]));
	const chapel = byId.get("bundle/chunk/node_modules/@shikijs/langs/dist/chapel.mjs/raw");
	expect(chapel).toMatchObject({ deltaPct: 50, verdict: "worse" });
	expect(byId.get("bundle/chunk/src/panels/PlanPane.tsx/raw")?.head.n).toBe(0);
	expect(byId.get("bundle/chunk/src/panels/FilesPane.tsx/raw")?.base.n).toBe(0);
	expect(byId.get("bundle/chunk/_c.js (from index.html)/raw")?.verdict).toBe("same");
	const markdown = renderSuite({
		name: "bundle",
		schedule: { kind: "once" },
		variants: [{ name: "web", status: "ok" }],
		metrics,
		loadavg: [],
	});
	expect(markdown).toContain(
		"| node_modules/@shikijs/langs/dist/chapel.mjs (raw) | 1000 B | 1.5 KiB | +500 B (+50%) | exact | ▮▮▮▮ worse |",
	);
	expect(markdown).toContain("| src/panels/PlanPane.tsx (raw) | 1000 B | – | removed |");
	expect(markdown).toContain("| src/panels/FilesPane.tsx (raw) | – | 1000 B | new |");
});

test("measureBundle fails without a manifest", async () => {
	await expect(measureBundle(join(root, "missing"))).rejects.toThrow("no Vite manifest");
});

test("hashMask blanks every output file hash so renamed imports do not change compressed size", () => {
	const mask = hashMask(["assets/chunk-QTnfLwEv.js", "assets/index-D8ugW8tW.css", "x.js"]);
	expect(mask('import"./chunk-QTnfLwEv.js";url(index-D8ugW8tW.css)')).toBe(
		'import"./chunk-________.js";url(index-________.css)',
	);
});
