import { describe, expect, test } from "bun:test";
import { makeGraph, makeSymbol } from "./fixture";
import { buildGraphIndex } from "./graphIndex";
import { buildSearchEntries, scoreEntry, searchEntries } from "./search";

const graph = {
	...makeGraph({
		symbols: [
			makeSymbol({ file: "a/chat.tsx", name: "ChatView", kind: "component", barrelExported: true }),
			makeSymbol({ file: "a/chat.test.tsx", name: "ChatViewFixture", isTest: true }),
			makeSymbol({ file: "a/useChat.ts", name: "useChat", kind: "hook" }),
			makeSymbol({ file: "a/x.ts", name: "reformatChat" }),
			makeSymbol({ file: "s/h.ts", name: "session.prompt", kind: "wire-handler" }),
			makeSymbol({ file: "a/t.ts", name: "ChatState", kind: "interface" }),
			makeSymbol({ file: "a/m.ts", name: "(module)", kind: "module" }),
		],
	}),
	files: [
		{
			path: "a/chat.tsx",
			module: "a",
			lines: 1,
			isTest: false,
			commits90d: 0,
			imports: [],
			contentHash: "",
			tokenHash: "",
		},
	],
	modules: [{ path: "packages/chat", lines: 1, files: 1, title: "Chat" }],
};
const entries = buildSearchEntries(buildGraphIndex(graph));

function labels(query: string, filter: Parameters<typeof searchEntries>[0]["filter"] = "all") {
	return searchEntries({ entries, query, filter, limit: 10 }).map((entry) => entry.label);
}

describe("search", () => {
	test("ranks exact, then prefix, then word boundary, then substring", () => {
		expect(scoreEntry({ label: "chat", lower: "chat" }, "chat")).toBeGreaterThan(
			scoreEntry({ label: "chatView", lower: "chatview" }, "chat") ?? 0,
		);
		expect(scoreEntry({ label: "chatView", lower: "chatview" }, "chat")).toBeGreaterThan(
			scoreEntry({ label: "useChat", lower: "usechat" }, "chat") ?? 0,
		);
		expect(scoreEntry({ label: "useChat", lower: "usechat" }, "chat")).toBeGreaterThan(
			scoreEntry({ label: "rechats", lower: "rechats" }, "chat") ?? 0,
		);
	});

	test("demotes tests below production and skips module pseudo symbols", () => {
		const result = labels("chatview");
		expect(result[0]).toBe("ChatView");
		expect(result).toContain("ChatViewFixture");
		expect(labels("module")).not.toContain("(module)");
	});

	test("matches camel initials and fuzzy subsequences", () => {
		expect(labels("cv")).toContain("ChatView");
		expect(labels("chtvw")).toContain("ChatView");
	});

	test("finds wire methods by dotted name", () => {
		expect(labels("session.prompt")[0]).toBe("session.prompt");
	});

	test("filters by kind, file and module", () => {
		expect(labels("chat", "type")).toEqual(["ChatState"]);
		expect(labels("chat", "hook")).toEqual(["useChat"]);
		expect(labels("chat", "file")).toEqual(["chat.tsx"]);
		expect(labels("chat", "module")).toEqual(["packages/chat"]);
	});

	test("returns nothing for a blank query", () => {
		expect(labels("   ")).toEqual([]);
	});
});
