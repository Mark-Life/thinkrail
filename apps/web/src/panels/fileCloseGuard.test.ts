import { expect, test } from "bun:test";
import type { FileSaveMode } from "@thinkrail/contracts";
import type { FileBufferSummary } from "../store";
import { closeAction } from "./fileCloseGuard";

const FILE = { workspaceId: "ws", path: "a.ts" };

const action = (summary: FileBufferSummary | null, fileSaveMode: FileSaveMode) =>
	closeAction(
		{ fileSaveMode, fileBuffersByWorkspace: summary ? { ws: { "a.ts": summary } } : {} },
		FILE,
	);

test("auto mode saves first while a write is coming or running; a paused file asks", () => {
	expect(action(null, "auto")).toBe("close");
	expect(action({ status: "dirty", dirty: true, pending: true }, "auto")).toBe("saveFirst");
	expect(action({ status: "saving", dirty: true }, "auto")).toBe("saveFirst");
	expect(action({ status: "dirty", dirty: true }, "auto")).toBe("ask");
	expect(action({ status: "conflict", dirty: true, pending: true }, "auto")).toBe("ask");
});

test("manual mode asks for every unsaved file", () => {
	expect(action({ status: "saving", dirty: true }, "manual")).toBe("ask");
	expect(action({ status: "dirty", dirty: true, pending: true }, "manual")).toBe("ask");
	expect(action({ status: "clean", dirty: false }, "manual")).toBe("close");
});
