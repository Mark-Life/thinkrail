import { expect, test } from "bun:test";
import { fileExists } from "./probe";

const tree: Record<string, string[]> = { ".": ["src"], src: ["src/a.ts"] };
const listDir = async (dir: string) => {
	const names = tree[dir];
	if (!names) throw new Error(`ENOENT: ${dir}`);
	return names.map((path) => ({ path }));
};

test("a name listed in its folder exists, and a name missing from it does not", async () => {
	expect(await fileExists(listDir, "src/a.ts")).toBe(true);
	expect(await fileExists(listDir, "src/b.ts")).toBe(false);
});

test("a file whose folder is gone does not exist", async () => {
	expect(await fileExists(listDir, "gone/deeper/a.ts")).toBe(false);
});

test("a listing failure on a folder that is still there is not an answer", async () => {
	const failing = async (dir: string) => {
		if (dir === "src") throw new Error("Request timed out");
		return listDir(dir);
	};
	await expect(fileExists(failing, "src/a.ts")).rejects.toThrow("Request timed out");
	await expect(fileExists(() => Promise.reject(new Error("host down")), "a.ts")).rejects.toThrow(
		"host down",
	);
});
