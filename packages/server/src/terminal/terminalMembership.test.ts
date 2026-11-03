import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asProjectId, asWorkspaceId } from "@thinkrail/contracts";
import { removeTree } from "@thinkrail/shared/removeTree";
import { saveWorkspaces } from "../persistence";
import {
	attachTerminal,
	closeTerminalTab,
	closeWorkspaceTerminals,
	listTerminals,
	resetTerminalState,
	reviveTerminalSessions,
	setTerminalPublisher,
} from "./terminalManager";

const WS = asWorkspaceId("ws-1");
const SAVED_ENV = ["THINKRAIL_DATA_DIR", "HISTFILE", "HISTSIZE", "ZDOTDIR"].map(
	(name) => [name, process.env[name]] as const,
);
let dataDir: string;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "trpi-terminal-membership-"));
	process.env.THINKRAIL_DATA_DIR = dataDir;
	process.env.HISTFILE = join(dataDir, ".test_history");
	process.env.HISTSIZE = "0";
	process.env.ZDOTDIR = dataDir;
	const worktreePath = join(dataDir, "worktree");
	mkdirSync(worktreePath);
	saveWorkspaces([
		{
			id: WS,
			projectId: asProjectId("project-1"),
			name: "Workspace",
			branch: "main",
			baseBranch: "main",
			worktreePath,
		},
	]);
	setTerminalPublisher(() => "delivered");
});

afterEach(() => {
	resetTerminalState();
	setTerminalPublisher(() => "unavailable");
	removeTree(dataDir);
	for (const [name, value] of SAVED_ENV) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

describe("membership survives an ungraceful exit", () => {
	test("a tab closed before a crash does not come back", () => {
		attachTerminal(WS, "tab-a", "client-1");
		closeTerminalTab(WS, "tab-a", true);

		resetTerminalState();
		reviveTerminalSessions();

		expect(listTerminals(WS)).toHaveLength(0);
	});

	test("a tab opened before a crash is still there", () => {
		attachTerminal(WS, "tab-a", "client-1", { title: "Survivor" });

		resetTerminalState();
		reviveTerminalSessions();

		expect(listTerminals(WS)).toEqual([{ tabKey: "tab-a", title: "Survivor" }]);
	});

	test("archiving a workspace before a crash takes its tabs with it", () => {
		attachTerminal(WS, "tab-a", "client-1");
		closeWorkspaceTerminals(WS);

		resetTerminalState();
		reviveTerminalSessions();

		expect(listTerminals(WS)).toHaveLength(0);
	});
});
