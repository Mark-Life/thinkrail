import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialJsFiles, measureBundle } from "./suiteBundle";

const dist = mkdtempSync(join(tmpdir(), "perf-compare-bundle-"));
afterAll(() => rmSync(dist, { recursive: true, force: true }));

const manifest = {
	"index.html": {
		file: "assets/index.js",
		isEntry: true,
		imports: ["_vendor.js"],
		dynamicImports: ["src/Chat.tsx"],
		css: ["assets/index.css"],
	},
	"_vendor.js": { file: "assets/vendor.js" },
	"src/Chat.tsx": { file: "assets/Chat.js", isDynamicEntry: true, imports: ["_vendor.js"] },
};
const files = {
	"assets/index.js": "a".repeat(1000),
	"assets/vendor.js": "v".repeat(3000),
	"assets/Chat.js": "c".repeat(500),
	"assets/index.css": "body{}",
};
mkdirSync(join(dist, ".vite"), { recursive: true });
mkdirSync(join(dist, "assets"));
writeFileSync(join(dist, ".vite", "manifest.json"), JSON.stringify(manifest));
for (const [file, content] of Object.entries(files)) writeFileSync(join(dist, file), content);

test("initial JS follows static imports from entries only", () => {
	expect(initialJsFiles(manifest).sort()).toEqual(["assets/index.js", "assets/vendor.js"]);
});

test("measureBundle reports raw, gzip and brotli sizes per chunk and type", () => {
	const byId = new Map(measureBundle(dist).map((m) => [m.id, m]));
	expect(byId.get("bundle/initial-js/raw")?.value).toBe(4000);
	expect(byId.get("bundle/total/js/raw")?.value).toBe(4500);
	expect(byId.get("bundle/total/css/raw")?.value).toBe(6);
	expect(byId.get("bundle/files")).toMatchObject({ value: 4, unit: "count" });
	expect(byId.get("bundle/chunk/src/Chat.tsx/raw")?.value).toBe(500);
	const gzip = byId.get("bundle/chunk/_vendor.js/gzip")?.value ?? 0;
	const brotli = byId.get("bundle/chunk/_vendor.js/brotli")?.value ?? 0;
	expect(gzip).toBeGreaterThan(0);
	expect(gzip).toBeLessThan(100);
	expect(brotli).toBeGreaterThan(0);
	expect([...byId.values()].every((m) => m.kind === "exact")).toBe(true);
});

test("measureBundle fails without a manifest", () => {
	expect(() => measureBundle(join(dist, "missing"))).toThrow("no Vite manifest");
});
