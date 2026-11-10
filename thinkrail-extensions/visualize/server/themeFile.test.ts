import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { THEME_CSS, THEME_FILE_NAME, writeThemeFile } from "./themeFile";

const SCRATCH = ".thinkrail/context/mockups/";
let cwd = "";

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "theme-file-"));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

describe("writeThemeFile", () => {
	test("embeds the generated semantic tokens for light and dark", () => {
		expect(THEME_CSS).toContain("--text-default:");
		expect(THEME_CSS).toContain("--container-workspace-bg:");
		expect(THEME_CSS).toContain("@media (prefers-color-scheme: dark)");
		expect(THEME_CSS).toContain("\n@layer thinkrail-theme {\n\t:root {\n");
		expect(THEME_CSS).not.toContain(":where(");
	});

	test("creates the mockup directory inside the seeded context dir and writes the file", async () => {
		mkdirSync(join(cwd, ".thinkrail/context"), { recursive: true });
		expect(await writeThemeFile({ cwd, scratchDir: SCRATCH })).toBe("written");
		expect(readFileSync(join(cwd, SCRATCH, THEME_FILE_NAME), "utf8")).toBe(THEME_CSS);
	});

	test("skips a workspace whose context dir the host never seeded", async () => {
		expect(await writeThemeFile({ cwd, scratchDir: SCRATCH })).toBe("skipped");
		expect(existsSync(join(cwd, ".thinkrail"))).toBe(false);
	});

	test("leaves an identical file untouched and rewrites a stale one", async () => {
		mkdirSync(join(cwd, ".thinkrail/context"), { recursive: true });
		const path = join(cwd, SCRATCH, THEME_FILE_NAME);
		await writeThemeFile({ cwd, scratchDir: SCRATCH });
		utimesSync(path, new Date(0), new Date(0));
		expect(await writeThemeFile({ cwd, scratchDir: SCRATCH })).toBe("unchanged");
		expect(statSync(path).mtimeMs).toBe(0);
		writeFileSync(path, "/* edited */");
		expect(await writeThemeFile({ cwd, scratchDir: SCRATCH })).toBe("written");
		expect(readFileSync(path, "utf8")).toBe(THEME_CSS);
	});

	test("refuses a scratch directory that links outside the workspace", async () => {
		const outside = mkdtempSync(join(tmpdir(), "theme-outside-"));
		try {
			mkdirSync(join(cwd, ".thinkrail/context"), { recursive: true });
			symlinkSync(outside, join(cwd, ".thinkrail/context/mockups"));
			await expect(writeThemeFile({ cwd, scratchDir: SCRATCH })).rejects.toThrow(
				/not a real directory/,
			);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("refuses a theme file that links outside the workspace and leaves its target alone", async () => {
		const outside = mkdtempSync(join(tmpdir(), "theme-outside-"));
		try {
			const target = join(outside, "victim.txt");
			writeFileSync(target, "victim");
			mkdirSync(join(cwd, SCRATCH), { recursive: true });
			symlinkSync(target, join(cwd, SCRATCH, THEME_FILE_NAME));
			await expect(writeThemeFile({ cwd, scratchDir: SCRATCH })).rejects.toThrow(
				/not a regular file/,
			);
			expect(readFileSync(target, "utf8")).toBe("victim");
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("refuses a scratch directory with a dot segment before it creates anything", async () => {
		mkdirSync(join(cwd, "workspace/.thinkrail/context"), { recursive: true });
		mkdirSync(join(cwd, "other"));
		const workspace = join(cwd, "workspace");
		for (const scratchDir of [
			"../other/mockups/",
			".thinkrail/context/../../../other/mockups/",
			".thinkrail/context/./mockups/",
			".thinkrail/context/..",
		]) {
			await expect(writeThemeFile({ cwd: workspace, scratchDir })).rejects.toThrow(
				/not a scratch directory/,
			);
		}
		expect(existsSync(join(cwd, "other/mockups"))).toBe(false);
		expect(existsSync(join(workspace, SCRATCH))).toBe(false);
		expect(existsSync(join(workspace, ".thinkrail", THEME_FILE_NAME))).toBe(false);
	});

	test("creates nothing through a symlinked ancestor", async () => {
		const outside = mkdtempSync(join(tmpdir(), "theme-outside-"));
		try {
			mkdirSync(join(outside, "context"));
			symlinkSync(outside, join(cwd, ".thinkrail"));
			await expect(writeThemeFile({ cwd, scratchDir: SCRATCH })).rejects.toThrow(
				/not a real directory/,
			);
			expect(existsSync(join(outside, "context", "mockups"))).toBe(false);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});
