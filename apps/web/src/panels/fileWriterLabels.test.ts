import { expect, test } from "bun:test";
import type { FsChangeAuthor } from "@thinkrail/contracts";
import { currentTranslator } from "@thinkrail/locales/react";
import { writerLabels } from "./fileWriterLabels";

const t = currentTranslator();
const tool: FsChangeAuthor = { kind: "agent", sessionId: "s1-0a3f", via: "tool", toolName: "edit" };
const script: FsChangeAuthor = { kind: "agent", sessionId: "s1-0a3f", via: "script" };

test("an agent shows its chat title, and screen readers hear that it is an agent", () => {
	expect(writerLabels(t, tool, "Fix auth")).toEqual({
		label: "Fix auth",
		spoken: "Agent Fix auth",
	});
});

test("an agent's script write reads the same as its tool write", () => {
	expect(writerLabels(t, script, "Fix auth")).toEqual(writerLabels(t, tool, "Fix auth"));
	expect(writerLabels(t, script, "")).toEqual(writerLabels(t, tool, ""));
});

test("an agent with no known chat title is told apart by its session id's last 4 characters", () => {
	expect(writerLabels(t, tool, "")).toEqual({ label: "Agent · 0a3f", spoken: "Agent · 0a3f" });
	const other: FsChangeAuthor = { ...tool, sessionId: "s2-91bc" };
	expect(writerLabels(t, other, "").label).not.toBe(writerLabels(t, tool, "").label);
});

test("an outside writer and the user get plain names", () => {
	expect(writerLabels(t, { kind: "external" }, "").label).toBe("External");
	expect(writerLabels(t, { kind: "user", mine: true }, "").label).toBe("You");
	expect(writerLabels(t, { kind: "user", mine: false }, "").label).toBe("You, in another window");
});
