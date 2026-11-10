#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "cn/build";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const OUT = join(ROOT, "packages/ui/generated/cn-tables.ts");
const CONTENT = [
	"apps/web/src/**/*.{ts,tsx}",
	"packages/ui/*.{ts,tsx}",
	"packages/resource-renderers/src/**/*.{ts,tsx}",
	"thinkrail-extensions/*/web/**/*.{ts,tsx}",
];
const eol = (text: string) => text.replaceAll("\r\n", "\n");

const check = process.argv.includes("--check");
const scratch = check ? mkdtempSync(join(tmpdir(), "cn-tables-")) : null;
try {
	const { source } = await build({
		cwd: ROOT,
		content: CONTENT,
		css: "apps/web/src/index.css",
		out: scratch ? join(scratch, "cn-tables.ts") : OUT,
	});
	if (check) {
		const committed = existsSync(OUT) ? eol(readFileSync(OUT, "utf8")) : "";
		if (committed !== eol(source)) {
			console.error("cn-tables: packages/ui/generated/cn-tables.ts is STALE");
			console.error("Run `bun run cn-tables:generate` and commit the result.");
			process.exit(1);
		}
		console.log("cn-tables: generated output is up to date");
	} else {
		console.log("cn-tables: wrote packages/ui/generated/cn-tables.ts");
	}
} finally {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
}
