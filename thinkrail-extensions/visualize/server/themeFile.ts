/// <reference path="./themeCss.d.ts" />
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import THEME_CSS from "./generated/thinkrail-theme.css" with { type: "text" };

export const THEME_FILE_NAME = "thinkrail-theme.css";

export { THEME_CSS };

async function realDirectory(path: string): Promise<boolean | null> {
	const entry = await lstat(path).catch(() => null);
	if (!entry) return null;
	if (!entry.isDirectory()) throw new Error(`not a real directory: ${path}`);
	return true;
}

/** Writes only inside an existing real `.thinkrail/context`, so it never creates an un-ignored tree. */
export async function writeThemeFile({
	cwd,
	scratchDir,
}: {
	cwd: string;
	scratchDir: string;
}): Promise<"written" | "unchanged" | "skipped"> {
	const parts = scratchDir.split("/").filter((part) => part !== "");
	const leaf = parts.pop();
	if (!leaf || [...parts, leaf].some((part) => part === "." || part === "..")) {
		throw new Error(`not a scratch directory: ${scratchDir}`);
	}
	let dir = cwd;
	for (const part of parts) {
		dir = join(dir, part);
		if (!(await realDirectory(dir))) return "skipped";
	}
	dir = join(dir, leaf);
	if (!(await realDirectory(dir))) await mkdir(dir);
	const path = join(dir, THEME_FILE_NAME);
	const entry = await lstat(path).catch(() => null);
	if (entry && !entry.isFile()) throw new Error(`not a regular file: ${path}`);
	if (entry && (await readFile(path, "utf8")) === THEME_CSS) return "unchanged";
	await writeFile(path, THEME_CSS);
	return "written";
}
