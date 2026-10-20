#!/usr/bin/env bun

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBaseline, parseLintRun, runRatchet } from "./lintRatchet";

const root = join(import.meta.dir, "..");
const baselinePath = join(root, "lint-baseline.json");

const reportDir = mkdtempSync(join(tmpdir(), "lint-ratchet-"));
const reportPath = join(reportDir, "oxlint.json");
// Under Bun, oxlint stdout to a pipe stops at 64 KiB, so the report goes to a file.
const { exitCode } = Bun.spawnSync(["bun", "--bun", "x", "oxlint", "--format", "json"], {
	cwd: root,
	stdout: Bun.file(reportPath),
	stderr: "inherit",
});
const report = readFileSync(reportPath, "utf8");
rmSync(reportDir, { recursive: true });
const outcome = runRatchet(
	existsSync(baselinePath) ? parseBaseline(readFileSync(baselinePath, "utf8")) : {},
	parseLintRun(report, exitCode),
	{
		update: process.argv.includes("--update"),
		allowIncrease: process.argv.includes("--allow-increase"),
	},
);

for (const message of outcome.messages) (outcome.ok ? console.log : console.error)(message);
if (outcome.nextBaseline !== undefined) writeFileSync(baselinePath, outcome.nextBaseline);
process.exitCode = outcome.ok ? 0 : 1;
