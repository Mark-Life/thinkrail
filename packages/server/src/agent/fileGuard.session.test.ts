import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	createFauxCore,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createProvenance, type Provenance } from "../provenance";
import { fileGuardExtension } from "./fileGuard";

const model = {
	id: "guard",
	name: "guard",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4096,
};

interface ToolEnd {
	toolName: string;
	isError: boolean;
	text: string;
}

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "trpi-file-guard-session-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

async function session(input: { store: Provenance; extensions?: ExtensionFactory[] }) {
	const agentDir = join(root, ".agent");
	mkdirSync(agentDir, { recursive: true });
	const faux = createFauxCore({ provider: "guard", api: "guard", models: [model] });
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider("guard", {
		api: faux.api,
		apiKey: "test",
		baseUrl: "http://faux.local",
		streamSimple: faux.streamSimple,
		models: [{ ...model, api: faux.api }],
	});
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: root,
		agentDir,
		settingsManager,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [fileGuardExtension(input.store), ...(input.extensions ?? [])],
	});
	await resourceLoader.reload();
	const created = await createAgentSession({
		cwd: root,
		agentDir,
		modelRuntime,
		model: faux.getModel(),
		resourceLoader,
		sessionManager: SessionManager.inMemory(root),
		settingsManager,
	});
	const ends: ToolEnd[] = [];
	created.session.subscribe((event) => {
		if (event.type !== "tool_execution_end") return;
		const content: { type: string; text?: string }[] = event.result?.content ?? [];
		const text = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
		ends.push({ toolName: event.toolName, isError: event.isError, text });
	});
	return { faux, session: created.session, ends };
}

function call(
	name: string,
	args: Parameters<typeof fauxToolCall>[1],
	id: string,
): FauxResponseStep {
	return fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
}

test("in a real pi session the edit hint reaches the thrown edit error and a write block becomes its result", async () => {
	const store = createProvenance();
	const path = join(root, "a.ts");
	writeFileSync(path, "const ttl = 60;\n");
	const { faux, session: agent, ends } = await session({ store });
	const userSave: FauxResponseStep = () => {
		const before = readFileSync(path);
		writeFileSync(path, "const ttl = 3600;\n");
		store.recordWrite({
			path,
			author: { kind: "user", clientKey: "c" },
			before,
			after: readFileSync(path),
		});
		return fauxAssistantMessage(
			[
				fauxToolCall(
					"edit",
					{ path: "a.ts", edits: [{ oldText: "ttl = 60", newText: "ttl = 1" }] },
					{ id: "e1" },
				),
			],
			{ stopReason: "toolUse" },
		);
	};
	faux.setResponses([
		call("read", { path: "a.ts" }, "r1"),
		userSave,
		call("write", { path: "a.ts", content: "const ttl = 1;\n" }, "w1"),
		fauxAssistantMessage("done"),
	]);
	await agent.prompt("go");
	agent.dispose();

	const [, edited, written] = ends;
	expect(edited?.isError).toBe(true);
	expect(edited?.text).toContain("Could not find");
	expect(edited?.text).toContain(
		"ThinkRail: a.ts was changed by the user 0 s ago (line 1) since you last read it.",
	);
	expect(written).toMatchObject({ toolName: "write", isError: true });
	expect(written?.text).toStartWith("Blocked: a.ts changed since you read it (by the user");
	expect(readFileSync(path, "utf8")).toBe("const ttl = 3600;\n");
});

test("in a real pi session a bash call aborted before it runs leaves no open window", async () => {
	let offset = 0;
	const store = createProvenance({ now: () => Date.now() + offset });
	let release = (): void => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let reached = (): void => {};
	const waiting = new Promise<void>((resolve) => {
		reached = resolve;
	});
	const confirm: ExtensionFactory = (pi) => {
		pi.registerTool({
			name: "slow_tool",
			label: "slow",
			description: "slow",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		});
		pi.on("tool_call", async (event) => {
			if (event.toolName !== "slow_tool") return undefined;
			reached();
			await gate;
			return undefined;
		});
	};
	const { faux, session: agent, ends } = await session({ store, extensions: [confirm] });
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("bash", { command: "echo hi" }, { id: "b1" }),
				fauxToolCall("slow_tool", {}, { id: "s1" }),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	const prompting = agent.prompt("go");
	await waiting;
	const aborting = agent.abort();
	release();
	await Promise.all([prompting, aborting]);
	agent.dispose();
	expect(ends.find((end) => end.toolName === "bash")?.text).toBe("Operation aborted");

	const path = join(root, "later.ts");
	writeFileSync(path, "one\n");
	store.recordWrite({
		path,
		author: { kind: "user", clientKey: "c" },
		before: null,
		after: readFileSync(path),
	});
	offset = 10 * 60 * 1000;
	writeFileSync(path, "outside\n");
	const later = new Date(Date.now() + offset);
	utimesSync(path, later, later);
	expect(store.lastWrite({ path, hash: "other", clientKey: "c" })?.author).toEqual({
		kind: "external",
	});
});

test("in a real pi session a save made while a checked write waits on a sibling hook is named in the write result", async () => {
	const store = createProvenance();
	const path = join(root, "a.ts");
	writeFileSync(path, "one\n");
	const slow: ExtensionFactory = (pi) => {
		pi.registerTool({
			name: "slow_tool",
			label: "slow",
			description: "slow",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		});
		pi.on("tool_call", async (event) => {
			if (event.toolName !== "slow_tool") return undefined;
			const before = readFileSync(path);
			writeFileSync(path, "user work\n");
			store.recordWrite({
				path,
				author: { kind: "user", clientKey: "c" },
				before,
				after: readFileSync(path),
			});
			return undefined;
		});
	};
	const { faux, session: agent, ends } = await session({ store, extensions: [slow] });
	faux.setResponses([
		call("read", { path: "a.ts" }, "r1"),
		fauxAssistantMessage(
			[
				fauxToolCall("write", { path: "a.ts", content: "agent\n" }, { id: "w1" }),
				fauxToolCall("slow_tool", {}, { id: "s1" }),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	await agent.prompt("go");
	agent.dispose();

	const written = ends.find((end) => end.toolName === "write");
	expect(written?.isError).toBe(false);
	expect(written?.text).toContain(
		"ThinkRail: a.ts was changed by the user 0 s ago (line 1) after this write was checked, so this write replaced that change.",
	);
	expect(written?.text).toContain("-user work\n+agent");
	expect(readFileSync(path, "utf8")).toBe("agent\n");
});

test("in a real pi session an edit over a save the agent never read does not clear the way for a stale write", async () => {
	const store = createProvenance();
	const path = join(root, "a.ts");
	writeFileSync(path, "const a = 1;\nconst b = 2;\nconst c = 3;\n");
	const { faux, session: agent, ends } = await session({ store });
	const userSave: FauxResponseStep = () => {
		const before = readFileSync(path);
		writeFileSync(path, "const a = 1;\nconst b = 999;\nconst c = 3;\n");
		store.recordWrite({
			path,
			author: { kind: "user", clientKey: "c" },
			before,
			after: readFileSync(path),
		});
		const edits = [{ oldText: "a = 1", newText: "a = 10" }];
		return fauxAssistantMessage([fauxToolCall("edit", { path: "a.ts", edits }, { id: "e1" })], {
			stopReason: "toolUse",
		});
	};
	faux.setResponses([
		call("read", { path: "a.ts" }, "r1"),
		userSave,
		call("write", { path: "a.ts", content: "const a = 10;\nconst b = 2;\nconst c = 3;\n" }, "w1"),
		fauxAssistantMessage("done"),
	]);
	await agent.prompt("go");
	agent.dispose();

	const [, edited, written] = ends;
	expect(edited?.isError).toBe(false);
	expect(written).toMatchObject({ toolName: "write", isError: true });
	expect(written?.text).toStartWith("Blocked: a.ts changed since you read it (by the user");
	expect(written?.text).toContain("-const b = 2;\n+const a = 10;\n+const b = 999;");
	expect(readFileSync(path, "utf8")).toBe("const a = 10;\nconst b = 999;\nconst c = 3;\n");
});
