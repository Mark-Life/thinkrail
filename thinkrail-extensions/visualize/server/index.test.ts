import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type ExtensionSessionServices,
	MOCKUP_CDN_SOURCES,
	MOCKUP_THEME_CHANGE_EVENT,
} from "@thinkrail/extension-api/server";
import { mockupGuideline } from "./guidance";
import extension from "./index";
import { THEME_CSS } from "./themeFile";

type ExecResult = { content: Array<{ type: string; text: string }>; details: unknown };
type CapturedTool = {
	name: string;
	promptGuidelines?: string[];
	execute: (
		id: string,
		params: unknown,
		signal?: unknown,
		onUpdate?: unknown,
		ctx?: { cwd: string },
	) => Promise<ExecResult>;
};

const checked: Array<{ path: string; cwd: string }> = [];

const session: ExtensionSessionServices = {
	expectToolResponse: () => {},
	awaitToolResponse: async () => ({ kind: "deferred" }),
	setting: () => false,
	workspaceFiles: {
		check: async (path, cwd) => {
			checked.push({ path, cwd });
			if (path === "missing.html") throw new Error("no such file");
		},
		scratchDir: ".thinkrail/context/mockups/",
	},
};

type Handler = (event: unknown, ctx: { cwd: string }) => Promise<void> | void;

function loadExtension(): { tool: CapturedTool; handlers: Map<string, Handler> } {
	let captured: CapturedTool | undefined;
	const handlers = new Map<string, Handler>();
	const fakePi = {
		registerTool: (def: CapturedTool) => {
			captured = def;
		},
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
		},
	};
	const factory = extension.sessionExtensions?.(session)[0];
	if (!factory) throw new Error("server half declares no extension factory");
	factory(fakePi as unknown as ExtensionAPI);
	if (!captured) throw new Error("factory did not register a tool");
	return { tool: captured, handlers };
}

function loadTool(): CapturedTool {
	return loadExtension().tool;
}

describe("visualize server half", () => {
	test("composes one per-session parent extension named visualize and no children or skills", () => {
		expect(extension.name).toBe("visualize");
		expect(extension.title).toBe("Visualize");
		expect(extension.description).toBeTruthy();
		expect(extension.extensions).toHaveLength(0);
		expect(extension.sessionExtensions?.(session)).toHaveLength(1);
		expect(extension).not.toHaveProperty("childExtensions");
		expect(extension).not.toHaveProperty("skillPackages");
		expect(loadTool().name).toBe("visualize");
	});

	test("accepts valid Mermaid without leaking DOM globals", async () => {
		const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
		const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
		const res = await loadTool().execute("id", {
			type: "diagram",
			mermaid: "flowchart LR\n A[Start] --> B[Done]",
		});
		expect(res.content[0]?.text).toContain("```mermaid");
		expect(res.details).toEqual({
			type: "diagram",
			mermaid: "flowchart LR\n A[Start] --> B[Done]",
		});
		expect(Object.getOwnPropertyDescriptor(globalThis, "window")).toEqual(windowDescriptor);
		expect(Object.getOwnPropertyDescriptor(globalThis, "document")).toEqual(documentDescriptor);
	});

	test("rejects a dangling flowchart edge with the strict mermaid parse error", async () => {
		await expect(
			loadTool().execute("id", { type: "diagram", mermaid: "flowchart LR\n A -->" }),
		).rejects.toThrow(
			/visualize: invalid Mermaid syntax in `mermaid`[\s\S]*parse error[\s\S]*correct the syntax and call `visualize` again/i,
		);
	});

	test("rejects invalid comparison Mermaid with its option location", async () => {
		await expect(
			loadTool().execute("id", {
				type: "comparison",
				options: [
					{ name: "Valid", mermaid: "flowchart LR\n A --> B" },
					{ name: "Invalid", mermaid: "flowchart LR\n A -->" },
				],
			}),
		).rejects.toThrow(/visualize: invalid Mermaid syntax in `options\[1\]\.mermaid`/);
	});

	test("validates diagram kinds whose sanitizer needs a real document", async () => {
		for (const mermaid of [
			"classDiagram\n class A\n A : +run()",
			"stateDiagram-v2\n [*] --> Idle\n Idle --> Running",
			"gantt\n title T\n dateFormat YYYY-MM-DD\n section S\n Task :a1, 2024-01-01, 3d",
			"mindmap\n  root((r))\n    child",
		]) {
			await expect(loadTool().execute("id", { type: "diagram", mermaid })).resolves.toBeDefined();
		}
	});

	test("serializes Mermaid parsing across tool instances", async () => {
		await loadTool().execute("warmup", { type: "diagram", mermaid: "flowchart LR\n A --> B" });
		const mermaid = (await import("mermaid")).default;
		const parseDescriptor = Object.getOwnPropertyDescriptor(mermaid, "parse");
		let active = 0;
		let maxActive = 0;
		try {
			Object.defineProperty(mermaid, "parse", {
				configurable: true,
				value: async () => {
					active += 1;
					maxActive = Math.max(maxActive, active);
					await Bun.sleep(10);
					active -= 1;
				},
				writable: true,
			});
			await Promise.all([
				loadTool().execute("first", { type: "diagram", mermaid: "flowchart LR\n A --> B" }),
				loadTool().execute("second", { type: "diagram", mermaid: "flowchart LR\n C --> D" }),
			]);
			expect(maxActive).toBe(1);
		} finally {
			if (parseDescriptor) Object.defineProperty(mermaid, "parse", parseDescriptor);
		}
	});

	test("checks every file path through the host's workspace files", async () => {
		checked.length = 0;
		const tool = loadTool();
		const run = (params: unknown) =>
			tool.execute("id", params, undefined, undefined, { cwd: "/workspace" });
		await expect(
			run({ type: "file", path: ".thinkrail/context/mockups/after.html", before: "before.html" }),
		).resolves.toBeDefined();
		expect(checked).toEqual([
			{ path: ".thinkrail/context/mockups/after.html", cwd: "/workspace" },
			{ path: "before.html", cwd: "/workspace" },
		]);
		await expect(run({ type: "file", path: "missing.html" })).rejects.toThrow(
			/cannot show `path` \(missing\.html\): no such file/,
		);
	});

	test("points the mockup guideline at the scratch directory and its theme file", () => {
		const guideline = loadTool().promptGuidelines?.[0] ?? "";
		expect(guideline).toContain("`.thinkrail/context/mockups/`");
		expect(guideline).toContain("`.thinkrail/context/mockups/thinkrail-theme.css`");
		expect(guideline).toContain('href="thinkrail-theme.css"');
		expect(guideline).toContain("`var(--…)` tokens");
		expect(guideline).toContain(
			"in normal flow, or give `body` a pixel `min-height` that holds it: a `position: fixed` layer adds no height to the card, and neither does an absolutely positioned panel that opens after load",
		);
		expect(guideline).toContain("html/body) and show it with visualize type 'file'");
		expect(guideline).not.toContain("hosts may strip scripts");
	});

	test("offers scripts as an extra and asks for a mockup that is complete without them", () => {
		const guideline = loadTool().promptGuidelines?.[0] ?? "";
		expect(guideline).toContain("Some clients run no script and load nothing from a URL");
		expect(guideline).toContain("must look complete with no script and no CDN file");
		expect(guideline).toContain(
			"write all your own CSS in the file itself (a CDN file may only add what a script draws)",
		);
		expect(guideline).toContain(
			"a static version of anything a script draws as normal markup that the script replaces when it runs",
		);
		expect(guideline).toContain("Do not put that static version in `<noscript>`");
		expect(guideline).toContain("with no `<form>`");
		expect(guideline).toContain(
			"Do not call `history.pushState` or set `location.hash` (no hash router, no hash tabs): each call adds an entry to the app tab's history",
		);
		expect(guideline).toContain("WebAssembly runs only from inline bytes");
		expect(guideline).toContain(
			"Do not call `scrollIntoView()`, call `focus()` only in a handler of a user action, and do not cancel the Tab key",
		);
		expect(guideline).toContain(`\`${MOCKUP_THEME_CHANGE_EVENT}\` event`);
		for (const blocked of ["fetch", "XHR", "WebSocket", "workers", "`eval`", "`localStorage`"]) {
			expect(guideline).toContain(blocked);
		}
		for (const untrue of ["scripts run in the app", "the preview removes", "no network"]) {
			expect(guideline).not.toContain(untrue);
		}
	});

	test("names the library prefixes from the one CDN constant", () => {
		expect(MOCKUP_CDN_SOURCES.length).toBeGreaterThan(0);
		const guideline = loadTool().promptGuidelines?.[0] ?? "";
		for (const source of MOCKUP_CDN_SOURCES) expect(guideline).toContain(`\`${source}\``);
		expect(guideline).toContain("with an exact version in the URL");
		expect([...guideline.matchAll(/https:\/\/[^`]*/g)].map((match) => match[0])).toEqual([
			...MOCKUP_CDN_SOURCES,
		]);

		const none = mockupGuideline(".thinkrail/context/mockups/", []);
		expect(none).toContain("no library loads from a URL, so inline what you need.");
		expect(none).not.toContain("https://");
	});

	test("writes the theme file into the session's scratch directory before the agent starts", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "visualize-theme-"));
		mkdirSync(join(cwd, ".thinkrail/context"), { recursive: true });
		try {
			const start = loadExtension().handlers.get("before_agent_start");
			await start?.({}, { cwd });
			const written = readFileSync(
				join(cwd, ".thinkrail/context/mockups/thinkrail-theme.css"),
				"utf8",
			);
			expect(written).toBe(THEME_CSS);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
