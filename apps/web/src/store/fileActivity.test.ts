import { describe, expect, setSystemTime, test } from "bun:test";
import type { FsChangeWrite, WorkspaceFsChangedPayload } from "@thinkrail/contracts";
import { useAppStore } from "./appStore";
import {
	FILE_ACTIVITY_WINDOW_MS,
	type FileActivity,
	fileWriters,
	nextFileActivityExpiry,
	pruneFileActivity,
	withFsChangeActivity,
	withOwnFileSave,
	writerTone,
} from "./fileActivity";
import { selectFileAgentSlots, selectFileWrites } from "./selectors";

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
		expect(workspace?.agents).toEqual({ s1: 0, s2: 1 });
		expect(workspace?.paths["a.ts"]?.map((entry) => entry.hash)).toEqual(["h4", "h2", "h1"]);

		const writers = fileWriters(workspace?.paths["a.ts"] ?? [], workspace?.agents ?? {});
		expect(writers.map((writer) => [writer.id, writer.tone, writer.inferred])).toEqual([
			["agent:s2", "agent2", false],
			["external", "external", true],
			["agent:s1", "agent1", false],
		]);
	});

	test("your own saves stay for the hash lookup but are never a writer", () => {
		const saved = withOwnFileSave({}, { workspaceId: "ws", path: "a.ts", hash: "h1", seen: 0 });
		const activity = withFsChangeActivity(
			saved,
			frame({ "a.ts": write({ kind: "user" }, "h1") }),
			500,
		);
		expect(activity.ws?.paths["a.ts"]?.map((entry) => entry.author)).toEqual([
			{ kind: "user", mine: true },
		]);
		expect(fileWriters(activity.ws?.paths["a.ts"] ?? [], {})).toHaveLength(0);
	});

	test("a save from another window is a writer in the user tone", () => {
		const saved = withOwnFileSave({}, { workspaceId: "ws", path: "a.ts", hash: "h1", seen: 0 });
		const activity = withFsChangeActivity(
			saved,
			frame({ "a.ts": write({ kind: "user" }, "h2") }),
			500,
		);
		const writers = fileWriters(activity.ws?.paths["a.ts"] ?? [], {});
		expect(writers.map((writer) => [writer.id, writer.tone, writer.inferred])).toEqual([
			["user:elsewhere", "user", false],
		]);
	});

	test("your own autosaves never push another writer out of the window", () => {
		let activity = withFsChangeActivity({}, frame({ "a.ts": write(agent("s1"), "h0") }), 0);
		for (let index = 1; index <= 12; index++) {
			const hash = `mine${index}`;
			activity = withOwnFileSave(activity, { workspaceId: "ws", path: "a.ts", hash, seen: 0 });
			activity = withFsChangeActivity(
				activity,
				frame({ "a.ts": write({ kind: "user" }, hash) }),
				index * 1000,
			);
		}
		const writes = activity.ws?.paths["a.ts"] ?? [];
		expect(writes.map((entry) => entry.hash)).toEqual(["mine12", "h0"]);
		expect(fileWriters(writes, activity.ws?.agents ?? {}).map((writer) => writer.id)).toEqual([
			"agent:s1",
		]);
	});

	test("a script write is inferred and keeps its session's tone", () => {
		const activity = withFsChangeActivity(
			{},
			frame({ "a.ts": write(agent("s1", "script"), "h1") }),
			0,
		);
		const [writer] = fileWriters(activity.ws?.paths["a.ts"] ?? [], activity.ws?.agents ?? {});
		expect(writer).toMatchObject({ id: "agent:s1", tone: "agent1", inferred: true });
	});

	test("past 64 sessions, agents keep their tone and the oldest idle one gives up its slot", () => {
		let activity = withFsChangeActivity({}, frame({ "live.ts": write(agent("s0"), "h0") }), 0);
		for (let index = 1; index < 64; index++) {
			activity = withFsChangeActivity(
				activity,
				frame({ "x.ts": write(agent(`s${index}`), `h${index}`) }),
				0,
			);
		}
		const tones = () =>
			["s0", "s2", "s63"].map((id) => writerTone(agent(id), activity.ws?.agents ?? {}));
		const before = tones();
		activity = withFsChangeActivity(activity, frame({ "y.ts": write(agent("s64"), "h64") }), 0);
		expect(tones()).toEqual(before);
		expect(Object.keys(activity.ws?.agents ?? {})).toHaveLength(64);
		expect(activity.ws?.agents.s0).toBe(0);
		expect(activity.ws?.agents.s1).toBeUndefined();
		expect(writerTone(agent("s64"), activity.ws?.agents ?? {})).toBe("agent2");
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
		expect(pruned.ws?.agents).toEqual({ s1: 0 });
		expect(nextFileActivityExpiry(pruned)).toBeNull();
	});
});

describe("the store slice", () => {
	test("noteFsChanged folds authors, prune fades them, and removing the workspace drops them", () => {
		useAppStore.setState({ fileActivityByWorkspace: {}, removedWorkspaceIds: {} });
		const s = () => useAppStore.getState();
		s().noteFsChanged(frame({ "a.ts": write(agent("s1"), "h1") }));
		expect(selectFileWrites(s(), "ws", "a.ts").map((entry) => entry.hash)).toEqual(["h1"]);
		expect(selectFileAgentSlots(s(), "ws")).toEqual({ s1: 0 });

		const before = s().fileActivityByWorkspace;
		s().noteFsChanged({ ...frame({}), paths: ["b.ts"], authors: undefined });
		expect(s().fileActivityByWorkspace).toBe(before);

		s().expireFileActivity();
		expect(selectFileWrites(s(), "ws", "a.ts")).toHaveLength(0);

		s().noteFsChanged(frame({ "a.ts": write(agent("s1"), "h2") }));
		s().applyWorkspaceRemoved("p1", "ws");
		expect(s().fileActivityByWorkspace.ws).toBeUndefined();
		s().noteFsChanged(frame({ "a.ts": write(agent("s1"), "h3") }));
		expect(s().fileActivityByWorkspace.ws).toBeUndefined();
	});

	test("a prune timer that fires before the wall clock reaches the expiry still prunes", () => {
		useAppStore.setState({ fileActivityByWorkspace: {}, removedWorkspaceIds: {} });
		const s = () => useAppStore.getState();
		setSystemTime(new Date(1_000_000));
		try {
			s().noteFsChanged(frame({ "a.ts": write(agent("s1"), "h1") }));
			setSystemTime(new Date(1_000_000 + FILE_ACTIVITY_WINDOW_MS - 5));
			s().expireFileActivity();
			expect(selectFileWrites(s(), "ws", "a.ts")).toHaveLength(0);
		} finally {
			setSystemTime();
		}
	});

	test("an authors-only frame folds its author without a second invalidation", () => {
		useAppStore.setState({
			fileActivityByWorkspace: {},
			fsChangesByWorkspace: {},
			removedWorkspaceIds: {},
		});
		const s = () => useAppStore.getState();
		s().noteFsChanged({ ...frame({}), paths: ["a.ts"], authors: undefined });
		const change = s().fsChangesByWorkspace.ws;
		s().noteFsChanged({ ...frame({ "a.ts": write(agent("s1"), "h1") }), authorsOnly: true });
		expect(s().fsChangesByWorkspace.ws).toBe(change);
		expect(selectFileWrites(s(), "ws", "a.ts").map((entry) => entry.hash)).toEqual(["h1"]);
	});
});
