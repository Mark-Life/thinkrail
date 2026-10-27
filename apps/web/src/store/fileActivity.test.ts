import { describe, expect, setSystemTime, test } from "bun:test";
import type { FileRead, FsChangeWrite, WorkspaceFsChangedPayload } from "@thinkrail/contracts";
import { useAppStore } from "./appStore";
import {
	FILE_ACTIVITY_WINDOW_MS,
	type FileActivity,
	fileWriter,
	fileWriters,
	nextFileActivityExpiry,
	pruneFileActivity,
	withFileReadActivity,
	withFsChangeActivity,
	withOwnFileSave,
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
			["s0", "s2", "s63"].map((id) => fileWriter(agent(id), activity.ws?.agents ?? {})?.tone);
		const before = tones();
		activity = withFsChangeActivity(activity, frame({ "y.ts": write(agent("s64"), "h64") }), 0);
		expect(tones()).toEqual(before);
		expect(Object.keys(activity.ws?.agents ?? {})).toHaveLength(64);
		expect(activity.ws?.agents.s0).toBe(0);
		expect(activity.ws?.agents.s1).toBeUndefined();
		expect(fileWriter(agent("s64"), activity.ws?.agents ?? {})?.tone).toBe("agent2");
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

	test("your own saves expire with the window, so saved paths do not pile up", () => {
		let activity: FileActivity = {};
		for (let index = 0; index < 1000; index++) {
			activity = withOwnFileSave(activity, {
				workspaceId: "ws",
				path: `p${index}`,
				hash: `h${index}`,
				seen: 1000,
			});
		}
		expect(nextFileActivityExpiry(activity)).toBe(1000 + FILE_ACTIVITY_WINDOW_MS);
		expect(pruneFileActivity(activity, 1000 + FILE_ACTIVITY_WINDOW_MS - 1)).toBe(activity);
		const pruned = pruneFileActivity(activity, 1000 + FILE_ACTIVITY_WINDOW_MS);
		expect(pruned).not.toBe(activity);
		expect(pruned.ws?.saves).toEqual({});
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

	test("only the first own save moves the prune expiry; later saves and their echoes keep it", () => {
		useAppStore.setState({ fileActivityByWorkspace: {}, removedWorkspaceIds: {} });
		const s = () => useAppStore.getState();
		const expiries: (number | null)[] = [];
		const stop = useAppStore.subscribe((state, previous) => {
			const next = nextFileActivityExpiry(state.fileActivityByWorkspace);
			if (next !== nextFileActivityExpiry(previous.fileActivityByWorkspace)) expiries.push(next);
		});
		setSystemTime(new Date(1_000_000));
		try {
			s().noteOwnFileSave("ws", "a.ts", "h1");
			setSystemTime(new Date(1_001_000));
			s().noteFsChanged(frame({ "a.ts": write({ kind: "user" }, "h1") }));
			s().noteOwnFileSave("ws", "a.ts", "h2");
			s().noteOwnFileSave("ws", "b.ts", "h3");
			s().noteFsChanged(frame({ "a.ts": write({ kind: "user" }, "h2") }));
		} finally {
			setSystemTime();
			stop();
		}
		expect(expiries).toEqual([1_000_000 + FILE_ACTIVITY_WINDOW_MS]);
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

	describe("a read that carries the last write", () => {
		const NOW = 1_000_000;
		const read = (hash: string | null, lastWrite?: FileRead["lastWrite"]): FileRead => ({
			content: "x",
			meta: { hash } as FileRead["meta"],
			...(lastWrite ? { lastWrite } : {}),
		});
		const seed = (activity: FileActivity, file: FileRead) =>
			withFileReadActivity(activity, { workspaceId: "ws", path: "a.ts", file, now: NOW });

		test("seeds the writer a reload lost, with the agent's tone", () => {
			const activity = seed({}, read("h1", { author: agent("s1"), at: NOW - 5_000 }));
			expect(activity.ws?.paths["a.ts"]).toEqual([
				{ author: agent("s1"), hash: "h1", seen: NOW - 5_000 },
			]);
			expect(fileWriters(activity.ws?.paths["a.ts"] ?? [], activity.ws?.agents ?? {})).toEqual([
				{ id: "agent:s1", author: agent("s1"), tone: "agent1", inferred: false },
			]);
		});

		test("maps this client's write to mine, so it shows no writer", () => {
			const activity = seed(
				{},
				read("h1", { author: { kind: "user", thisClient: true }, at: NOW }),
			);
			expect(activity.ws?.paths["a.ts"]?.[0]?.author).toEqual({ kind: "user", mine: true });
			expect(fileWriters(activity.ws?.paths["a.ts"] ?? [], {})).toEqual([]);
		});

		test("ignores a write older than the window, no last write, and a server clock ahead", () => {
			const empty: FileActivity = {};
			expect(
				seed(empty, read("h1", { author: agent("s1"), at: NOW - FILE_ACTIVITY_WINDOW_MS })),
			).toBe(empty);
			expect(seed(empty, read("h1"))).toBe(empty);
			expect(
				seed(empty, read("h1", { author: agent("s1"), at: NOW + 9_000 })).ws?.paths["a.ts"]?.[0]
					?.seen,
			).toBe(NOW);
		});

		test("never displaces a newer live write or repeats a hash a frame already brought", () => {
			const live = withFsChangeActivity({}, frame({ "a.ts": write(agent("s2"), "h2") }), NOW);
			const seeded = seed(live, read("h1", { author: agent("s1"), at: NOW - 1_000 }));
			expect(seeded.ws?.paths["a.ts"]?.map((entry) => entry.hash)).toEqual(["h2", "h1"]);
			expect(seed(live, read("h2", { author: agent("s1"), at: NOW - 1_000 }))).toBe(live);
		});
	});
});
