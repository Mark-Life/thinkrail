import { expect, test } from "bun:test";
import type { FsChangeAuthor } from "@thinkrail/contracts";
import { currentTranslator } from "@thinkrail/locales/react";
import { writerLabel } from "./fileWriterLabels";

const t = currentTranslator();
const tool: FsChangeAuthor = { kind: "agent", sessionId: "s1", via: "tool", toolName: "edit" };
const script: FsChangeAuthor = { kind: "agent", sessionId: "s1", via: "script" };

test("an agent is named by its chat title, and a script write says so", () => {
	expect(writerLabel(t, tool, "Fix auth")).toBe("Agent · Fix auth");
	expect(writerLabel(t, script, "Fix auth")).toBe("Agent · Fix auth via script");
});

test("an agent with no known chat, an outside writer and the user get plain names", () => {
	expect(writerLabel(t, tool, "")).toBe("Agent");
	expect(writerLabel(t, { kind: "external" }, "")).toBe("External");
	expect(writerLabel(t, { kind: "user", mine: true }, "")).toBe("You");
	expect(writerLabel(t, { kind: "user", mine: false }, "")).toBe("You, in another window");
});
