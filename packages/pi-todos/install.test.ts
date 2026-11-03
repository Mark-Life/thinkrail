import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const PACKAGE_DIR = import.meta.dir;

function installedLikePi(root: string): string {
	const dir = join(root, "pi-todos");
	for (const entry of ["index.ts", "package.json", "core", "tools", "skills"]) {
		cpSync(join(PACKAGE_DIR, entry), join(dir, entry), { recursive: true });
	}
	const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8"));
	for (const name of Object.keys(manifest.dependencies ?? {})) {
		const link = join(dir, "node_modules", name);
		mkdirSync(dirname(link), { recursive: true });
		symlinkSync(join(PACKAGE_DIR, "node_modules", name), link);
	}
	return dir;
}

test("loads under vanilla pi with only what an install brings", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-todos-install-"));
	try {
		const loaded = await discoverAndLoadExtensions(
			[installedLikePi(root)],
			root,
			join(root, "agent"),
		);
		expect(loaded.errors).toEqual([]);
		expect(loaded.extensions).toHaveLength(1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
