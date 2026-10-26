import { describe, expect, test } from "bun:test";
import type { FsChangeWrite, WorkspaceFsChangedPayload } from "@thinkrail/contracts";
import { useAppStore } from "./appStore";
import {
	FILE_ACTIVITY_WINDOW_MS,
	type FileActivity,
	fileWriters,
	lastWriterTone,
	nextFileActivityExpiry,
	pruneFileActivity,
	withFsChangeActivity,
	workspaceWriterCount,
} from "./fileActivity";
import {
	selectFileLastWriterTone,
	selectFileWrites,
	selectWorkspaceWriterCount,
} from "./selectors";

const agent = (sessionId: string, via: "tool" | "script" = "tool"): FsChangeWrite["author"] =>
	via === "tool"
		? { kind: "agent", sessionId, via, toolName: "edit" }
		: { kind: "agent", sessionId, via };

const frame = (authors: Record<string, FsChangeWrite>): WorkspaceFsChangedPayload => ({
	workspaceId: "ws",
	paths: Object.keys(authors),
	truncated: false,
	skillChange: "none",
	authors,
});

const write = (author: FsChangeWrite["author"], hash: string): FsChangeWrite => ({
	author,
	hash,
});

describe("fileActivity", () => {
	test("a frame without authors leaves the slice as it was", () => {
		const activity: FileActivity = {};
		const payload = { ...frame({}), authors: undefined };
		expect(withFsChangeActivity(activity, payload, 0)).toBe(activity);
	});

	test("writes land newest first, and agents keep the slot of their first write", () => {
		let activity = withFsChangeActivity({}, frame({ "a.ts": write(agent("s1"), "h1") }), 1000);
		activity = withFsChangeActivity(
			activity,
			frame({ "a.ts": write({ kind: "external" }, "h2"), "b.ts": write(agent("s2"), "h3") }),
			2000,
		);
		activity = withFsChangeActivity(activity, frame({ "a.ts": write(agent("s2"), "h4") }), 3000);
		const workspace = activity.ws;
		expect(workspace?.agents).toEqual(["s1", "s2"]);
		expect(workspace?.paths["a.ts"]?.map((entry) => entry.hash)).toEqual(["h4", "h2", "h1"]);

		const writers = fileWriters(workspace?.paths["a.ts"] ?? [], workspace?.agents ?? []);
		expect(writers.map((writer) => [writer.id, writer.tone, writer.inferred])).toEqual([
			["agent:s2", "agent2", false],
			["external", "external", true],
			["agent:s1", "agent1", false],
		]);
		expect(lastWriterTone(workspace, "b.ts")).toBe("agent2");
		expect(workspaceWriterCount(workspace)).toBe(3);
	});

	test("user writes stay for the hash lookup but are never a writer", () => {
		const activity = withFsChangeActivity({}, frame({ "a.ts": write({ kind: "user" }, "h1") }), 0);
		expect(activity.ws?.paths["a.ts"]).toHaveLength(1);
		expect(fileWriters(activity.ws?.paths["a.ts"] ?? [], [])).toHaveLength(0);
		expect(lastWriterTone(activity.ws, "a.ts")).toBeNull();
		expect(workspaceWriterCount(activity.ws)).toBe(0);
	});

	test("a script write is inferred and keeps its session's tone", () => {
		const activity = withFsChangeActivity(
			{},
			frame({ "a.ts": write(agent("s1", "script"), "h1") }),
			0,
		);
		const [writer] = fileWriters(activity.ws?.paths["a.ts"] ?? [], activity.ws?.agents ?? []);
		expect(writer).toMatchObject({ id: "agent:s1", tone: "agent1", inferred: true });
	});

	test("the same frame twice records one write", () => {
		const payload = frame({ "a.ts": write(agent("s1"), "h1") });
		const activity = withFsChangeActivity(withFsChangeActivity({}, payload, 0), payload, 10);
		expect(activity.ws?.paths["a.ts"]).toHaveLength(1);
	});

	test("writes fade after the window, and pruning keeps untouched workspaces", () => {
		const activity = withFsChangeActivity({}, frame({ "a.ts": write(agent("s1"), "h1") }), 1000);
		expect(nextFileActivityExpiry(activity)).toBe(1000 + FILE_ACTIVITY_WINDOW_MS);
		expect(pruneFileActivity(activity, 1000 + FILE_ACTIVITY_WINDOW_MS - 1)).toBe(activity);
		const pruned = pruneFileActivity(activity, 1000 + FILE_ACTIVITY_WINDOW_MS);
		expect(pruned.ws?.paths).toEqual({});
		expect(pruned.ws?.agents).toEqual(["s1"]);
		expect(nextFileActivityExpiry(pruned)).toBeNull();
	});
});

describe("the store slice", () => {
	test("noteFsChanged folds authors, prune fades them, and removing the workspace drops them", () => {
		useAppStore.setState({ fileActivityByWorkspace: {}, removedWorkspaceIds: {} });
		const s = () => useAppStore.getState();
		s().noteFsChanged(frame({ "a.ts": write(agent("s1"), "h1") }));
		expect(selectFileWrites(s(), "ws", "a.ts").map((entry) => entry.hash)).toEqual(["h1"]);
		expect(selectFileLastWriterTone(s(), "ws", "a.ts")).toBe("agent1");
		expect(selectWorkspaceWriterCount(s(), "ws")).toBe(1);

		const before = s().fileActivityByWorkspace;
		s().noteFsChanged({ ...frame({}), paths: ["b.ts"], authors: undefined });
		expect(s().fileActivityByWorkspace).toBe(before);

		s().pruneFileActivity(Date.now() + FILE_ACTIVITY_WINDOW_MS);
		expect(selectFileWrites(s(), "ws", "a.ts")).toHaveLength(0);

		s().noteFsChanged(frame({ "a.ts": write(agent("s1"), "h2") }));
		s().applyWorkspaceRemoved("p1", "ws");
		expect(s().fileActivityByWorkspace.ws).toBeUndefined();
		s().noteFsChanged(frame({ "a.ts": write(agent("s1"), "h3") }));
		expect(s().fileActivityByWorkspace.ws).toBeUndefined();
	});
});
