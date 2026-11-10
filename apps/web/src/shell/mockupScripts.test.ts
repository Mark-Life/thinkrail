import { expect, test } from "bun:test";
import { DESKTOP_SHELL_GLOBAL } from "@thinkrail/contracts";
import type { ChatTurn, ToolResultState } from "../chat/types";
import { mockupHtmlMode } from "./mockupScripts";

const MOCKUP = ".thinkrail/context/mockups/chart.html";

function stateWith(
	args: Record<string, unknown>,
	status: ToolResultState["status"] = "done",
	name = "visualize",
) {
	const turn = {
		kind: "assistant",
		id: "a1",
		streaming: false,
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name, arguments: args }],
		},
	} as unknown as ChatTurn;
	return {
		tabsByWorkspace: { ws: [{ kind: "chat", id: "tab-1", sessionId: "s1", name: "Chat" }] },
		closedChatsByWorkspace: {},
		layoutDocumentsByWorkspace: {},
		sessions: { s1: { turns: [turn], toolResults: { "call-1": { status, raw: undefined } } } },
	} as unknown as Parameters<typeof mockupHtmlMode>[0];
}

const browser = {};

test("a mockup shown by a finished visualize call in the workspace runs scripts", () => {
	const shown = stateWith({ type: "file", path: MOCKUP });
	expect(mockupHtmlMode(shown, "ws", MOCKUP, browser)).toBe("scripted");
	const before = ".thinkrail/context/mockups/old.html";
	const compared = stateWith({ type: "file", path: MOCKUP, before });
	expect(mockupHtmlMode(compared, "ws", before, browser)).toBe("scripted");
	const dotted = stateWith({ type: "file", path: `./${MOCKUP}` });
	expect(mockupHtmlMode(dotted, "ws", MOCKUP, browser)).toBe("scripted");
});

test("a mockup no finished visualize call of this workspace showed stays themed", () => {
	const shown = stateWith({ type: "file", path: MOCKUP });
	const other = ".thinkrail/context/mockups/other.html";
	expect(mockupHtmlMode(shown, "ws", other, browser)).toBe("themed");
	expect(mockupHtmlMode(shown, "other-ws", MOCKUP, browser)).toBe("themed");
	for (const status of ["error", "running"] as const) {
		expect(
			mockupHtmlMode(stateWith({ type: "file", path: MOCKUP }, status), "ws", MOCKUP, browser),
		).toBe("themed");
	}
	const written = stateWith({ type: "file", path: MOCKUP }, "done", "write");
	expect(mockupHtmlMode(written, "ws", MOCKUP, browser)).toBe("themed");
	const unloaded = { ...shown, sessions: {} };
	expect(mockupHtmlMode(unloaded, "ws", MOCKUP, browser)).toBe("themed");
});

test("a visualize call that showed no file grants nothing", () => {
	const diagram = stateWith({ type: "diagram", mermaid: "graph TD; a-->b", path: MOCKUP });
	expect(mockupHtmlMode(diagram, "ws", MOCKUP, browser)).toBe("themed");
	const comparison = stateWith({ type: "comparison", options: [], before: MOCKUP });
	expect(mockupHtmlMode(comparison, "ws", MOCKUP, browser)).toBe("themed");
	expect(mockupHtmlMode(stateWith({ path: MOCKUP }), "ws", MOCKUP, browser)).toBe("themed");
});

test("a file outside the mockups dir is static even when a visualize call showed it", () => {
	const repoFile = stateWith({ type: "file", path: "index.html" });
	expect(mockupHtmlMode(repoFile, "ws", "index.html", browser)).toBe("static");
	const escaped = ".thinkrail/context/mockups/../index.html";
	expect(mockupHtmlMode(stateWith({ type: "file", path: escaped }), "ws", escaped, browser)).toBe(
		"static",
	);
	expect(
		mockupHtmlMode(
			stateWith({ type: "file", path: escaped }),
			"ws",
			".thinkrail/context/index.html",
		),
	).toBe("static");
});

const desktopShell = (marker: unknown) =>
	Object.defineProperty({}, DESKTOP_SHELL_GLOBAL, { value: marker });

test("a desktop shell without mockup scripts keeps a shown mockup themed", () => {
	const shown = stateWith({ type: "file", path: MOCKUP });
	const desktop = desktopShell(Object.freeze({ mockupScripts: false }));
	expect(mockupHtmlMode(shown, "ws", MOCKUP, desktop)).toBe("themed");
	expect(mockupHtmlMode(shown, "ws", "index.html", desktop)).toBe("static");
	for (const marker of [true, false, null, "yes", { mockupScripts: "true" }, {}]) {
		expect(mockupHtmlMode(shown, "ws", MOCKUP, desktopShell(marker))).toBe("themed");
	}
});

test("a desktop shell with mockup scripts runs a shown mockup like the browser", () => {
	const shown = stateWith({ type: "file", path: MOCKUP });
	const desktop = desktopShell(Object.freeze({ mockupScripts: true }));
	expect(mockupHtmlMode(shown, "ws", MOCKUP, desktop)).toBe("scripted");
	expect(
		mockupHtmlMode(stateWith({ type: "file", path: "other.html" }), "ws", MOCKUP, desktop),
	).toBe("themed");
	expect(mockupHtmlMode(shown, "ws", "index.html", desktop)).toBe("static");
});

test("a global that is not the shell's own property is not the desktop marker", () => {
	const shown = stateWith({ type: "file", path: MOCKUP });
	const named = Object.create({ [DESKTOP_SHELL_GLOBAL]: true });
	expect(Reflect.has(named, DESKTOP_SHELL_GLOBAL)).toBe(true);
	expect(mockupHtmlMode(shown, "ws", MOCKUP, named)).toBe("scripted");
});

test("shown paths are read once per turns array", () => {
	const shown = stateWith({ type: "file", path: MOCKUP });
	const turns = shown.sessions.s1?.turns ?? [];
	let reads = 0;
	const [turn] = turns;
	if (turn?.kind !== "assistant") throw new Error("expected an assistant turn");
	const counted = new Proxy(turn.message, {
		get(target, key, receiver) {
			if (key === "content") reads += 1;
			return Reflect.get(target, key, receiver);
		},
	});
	turns[0] = { ...turn, message: counted };
	for (let index = 0; index < 5; index += 1) {
		expect(mockupHtmlMode(shown, "ws", MOCKUP, browser)).toBe("scripted");
	}
	expect(reads).toBe(1);
	const restreamed = { ...shown, sessions: { s1: { ...shown.sessions.s1, turns: [...turns] } } };
	expect(mockupHtmlMode(restreamed as typeof shown, "ws", MOCKUP, browser)).toBe("scripted");
	expect(reads).toBe(2);
});
