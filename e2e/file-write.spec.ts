import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	FILE_WRITE_MAX_BYTES,
	type WorkspaceFsChangedPayload,
	WS_CHANNELS,
} from "@thinkrail/contracts";
import { openFixtureProject } from "./fixtures/app";
import { E2eWire } from "./fixtures/wire";

test("fs.writeFile saves under compare-and-swap and the watcher names the saved path", async ({
	page,
}) => {
	await openFixtureProject(page);
	const wire = await E2eWire.connect(Number(new URL(page.url()).port));
	try {
		const project = (await wire.request("project.list", {}))[0];
		if (!project) throw new Error("Missing fixture project");
		const workspace = await wire.request("workspace.create", { projectId: project.id });
		const target = { workspaceId: workspace.id, path: "README.md" };
		const before = await wire.request("fs.readFile", target);
		await wire.request("workspace.watchReady", { workspaceId: workspace.id });

		const changed = wire.push(WS_CHANNELS.workspaceFsChanged, (data) => {
			const payload = data as WorkspaceFsChangedPayload;
			return payload.workspaceId === workspace.id && payload.paths.includes(target.path);
		});
		const written = await wire.request("fs.writeFile", {
			...target,
			content: "# saved by e2e\n",
			expect: { hash: before.meta.hash },
		});
		expect(written.status).toBe("written");
		expect(readFileSync(join(workspace.worktreePath, target.path), "utf8")).toBe(
			"# saved by e2e\n",
		);
		await changed;

		const stale = await wire.request("fs.writeFile", {
			...target,
			content: "# from an old base\n",
			expect: { hash: before.meta.hash },
		});
		expect(stale).toMatchObject({ status: "stale", current: { content: "# saved by e2e\n" } });
		expect(readFileSync(join(workspace.worktreePath, target.path), "utf8")).toBe(
			"# saved by e2e\n",
		);

		await expect(
			wire.request("fs.writeFile", {
				workspaceId: workspace.id,
				path: "absent.md",
				content: "x\n",
				expect: { hash: before.meta.hash },
			}),
		).resolves.toEqual({ status: "missing" });
	} finally {
		wire.close();
	}
});

test("a save at the cap fits one frame even when JSON escapes every byte", async ({ page }) => {
	await openFixtureProject(page);
	const wire = await E2eWire.connect(Number(new URL(page.url()).port));
	try {
		const project = (await wire.request("project.list", {}))[0];
		if (!project) throw new Error("Missing fixture project");
		const workspace = await wire.request("workspace.create", { projectId: project.id });
		const written = await wire.request("fs.writeFile", {
			workspaceId: workspace.id,
			path: "control.txt",
			content: "\u0001".repeat(FILE_WRITE_MAX_BYTES),
			expect: { hash: null },
		});
		expect(written.status).toBe("written");
		expect(statSync(join(workspace.worktreePath, "control.txt")).size).toBe(FILE_WRITE_MAX_BYTES);
	} finally {
		wire.close();
	}
});
