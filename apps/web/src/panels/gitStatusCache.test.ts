import { expect, mock, test } from "bun:test";
import type { GitStatus, WorkspaceId } from "@thinkrail/contracts";
import { testWorkspaceId } from "@thinkrail/contracts/test-ids";

type Reply = { resolve: (status: GitStatus) => void; reject: (error: unknown) => void };
const replies: Reply[] = [];
const actualTransport = await import("../transport");
mock.module("../transport", () => ({
	...actualTransport,
	getTransport: () => ({
		request: () =>
			new Promise<GitStatus>((resolve, reject) => {
				replies.push({ resolve, reject });
			}),
	}),
}));

const { RequestError } = actualTransport;
const { useAppStore } = await import("../store");
const { GIT_STATUS_CACHE_SIZE, peekGitStatus, readGitStatus } = await import("./gitStatusCache");

const status = (branch: string): GitStatus => ({ branch, changes: [] });
const branch = { kind: "branch" } as const;

async function read(
	workspaceId: WorkspaceId,
	scope: Parameters<typeof readGitStatus>[1],
	ref: string,
) {
	const done = readGitStatus(workspaceId, scope, ref);
	replies.shift()?.resolve(status(`${workspaceId}:${ref}`));
	return done;
}

test("a read status is returned only for the same workspace, scope and target ref", async () => {
	await read(testWorkspaceId("ws-a"), branch, "main");
	expect(peekGitStatus(testWorkspaceId("ws-a"), branch, "main")?.branch).toBe("ws-a:main");
	expect(peekGitStatus(testWorkspaceId("ws-a"), branch, "develop")).toBeNull();
	expect(peekGitStatus(testWorkspaceId("ws-a"), { kind: "uncommitted" }, "")).toBeNull();
	expect(peekGitStatus(testWorkspaceId("ws-b"), branch, "main")).toBeNull();
});

test("a vanished commit forgets its entry", async () => {
	const scope = { kind: "commit", sha: "abc" } as const;
	await read(testWorkspaceId("ws-a"), scope, "");
	const failed = readGitStatus(testWorkspaceId("ws-a"), scope, "");
	replies.shift()?.reject(new RequestError("UNKNOWN_COMMIT", "gone"));
	await expect(failed).rejects.toThrow("gone");
	expect(peekGitStatus(testWorkspaceId("ws-a"), scope, "")).toBeNull();
});

test("an older reply that lands last does not overwrite a newer one", async () => {
	const older = readGitStatus(testWorkspaceId("ws-order"), branch, "main");
	const newer = readGitStatus(testWorkspaceId("ws-order"), branch, "main");
	const [first, second] = replies.splice(0, 2);
	second?.resolve(status("newer"));
	await newer;
	first?.resolve(status("older"));
	await older;
	expect(peekGitStatus(testWorkspaceId("ws-order"), branch, "main")?.branch).toBe("newer");
});

test("the cache keeps only the most recently used entries", async () => {
	await read(testWorkspaceId("ws-lru"), branch, "keep");
	for (let index = 0; index < GIT_STATUS_CACHE_SIZE - 1; index += 1) {
		await read(testWorkspaceId("ws-lru"), branch, `fill-${index}`);
	}
	expect(peekGitStatus(testWorkspaceId("ws-lru"), branch, "keep")).not.toBeNull();
	await read(testWorkspaceId("ws-lru"), branch, "overflow");
	expect(peekGitStatus(testWorkspaceId("ws-lru"), branch, "keep")).not.toBeNull();
	expect(peekGitStatus(testWorkspaceId("ws-lru"), branch, "fill-0")).toBeNull();
});

test("removing a workspace drops its entries", async () => {
	await read(testWorkspaceId("ws-gone"), branch, "main");
	await read(testWorkspaceId("ws-kept"), branch, "main");
	useAppStore.setState({
		removedWorkspaceIds: { ...useAppStore.getState().removedWorkspaceIds, "ws-gone": true },
	});
	expect(peekGitStatus(testWorkspaceId("ws-gone"), branch, "main")).toBeNull();
	expect(peekGitStatus(testWorkspaceId("ws-kept"), branch, "main")).not.toBeNull();
	await read(testWorkspaceId("ws-gone"), branch, "main");
	expect(peekGitStatus(testWorkspaceId("ws-gone"), branch, "main")).toBeNull();
});
