import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "@earendil-works/pi-schema";
import {
	AppConfig,
	asProjectId,
	asSessionId,
	asWorkspaceId,
	Project,
	Workspace,
} from "@thinkrail/contracts";
import {
	claimAppInstalled,
	ensureInstallation,
	loadConfig,
	loadHostEnvironment,
	loadProjects,
	loadSessionLifecycle,
	loadSessionReceipts,
	loadTerminalSessions,
	loadTurns,
	loadWorkspaces,
	saveConfig,
	saveProjects,
	saveWorkspaces,
} from "./persistence";

const savedDataDir = process.env.THINKRAIL_DATA_DIR;
let root: string;

const write = (file: string, value: unknown) =>
	writeFileSync(join(root, file), `${JSON.stringify(value, null, "\t")}\n`);
const noCopies = () =>
	expect(readdirSync(root).filter((name) => name.includes(".corrupt-"))).toEqual([]);

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "thinkrail-older-files-"));
	process.env.THINKRAIL_DATA_DIR = root;
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	if (savedDataDir === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = savedDataDir;
});

const PROJECTS = {
	"v0.0.1": { id: "p", name: "repo", path: "/repo", slug: "repo", lastOpened: 1 },
	"v0.1.6": {
		id: "p",
		name: "repo",
		path: "/repo",
		slug: "repo",
		lastOpened: 1,
		closed: true,
		trusted: false,
		acknowledgedSkills: ["a"],
		disabledSkills: ["b"],
		disabledGroups: ["c"],
		hookStatus: { retired: "kept as stored" },
	},
	"v0.3.1": {
		id: "p",
		name: "repo",
		path: "/repo",
		slug: "repo",
		lastOpened: 1,
		trusted: true,
		piResourceTrust: "granted",
		mcpApprovals: { server: "fingerprint" },
		mcpOverrides: { server: { enabled: true, exposure: "direct" } },
		mcpToolGrants: { server: { target: "hash", tools: ["tool"] } },
	},
};

const WORKSPACES = {
	"v0.0.1": {
		id: asWorkspaceId("w"),
		projectId: asProjectId("p"),
		name: "w",
		branch: "b",
		worktreePath: "/repo/w",
		baseBranch: "main",
		renamed: true,
		diffStats: { added: 1, removed: 2, changed: 3 },
	},
	"v0.1.6": {
		id: asWorkspaceId("w"),
		projectId: asProjectId("p"),
		kind: "external",
		name: "w",
		branch: "b",
		worktreePath: "/repo/w",
		baseBranch: "main",
		diffBase: "abc",
		initialTerminalPending: true,
		skillOverrides: { skill: "off" },
		subagentsOverride: "on",
	},
	"v0.3.1": {
		id: asWorkspaceId("w"),
		projectId: asProjectId("p"),
		kind: "default",
		name: "w",
		branch: "b",
		worktreePath: "/repo/w",
		baseBranch: "main",
		subagentMaxConcurrentOverride: 2,
		lastActiveAt: 5,
		settledOverride: "active",
		settledAt: 6,
	},
};

const MODEL_WITHOUT_LEVELS = {
	provider: "anthropic",
	id: "opus",
	name: "Opus",
	contextWindow: 1000,
	reasoning: true,
};
const MODEL = { ...MODEL_WITHOUT_LEVELS, thinkingLevels: ["off", "high"] };

const CONFIGS = {
	"v0.0.6": { theme: "dark" },
	"v0.1.0-nightly.17": { theme: "dark", analyticsEnabled: true },
	"v0.1.6": {
		theme: "dark",
		themeMode: "fixed",
		analyticsEnabled: true,
		analyticsConsentConfirmed: true,
		notificationsEnabled: false,
		terminalReplayKb: 512,
		composerGrowthLimit: "half-chat",
		reviewAutoFix: true,
		agentReviewEnabled: true,
		subagentsEnabled: false,
		defaultModel: MODEL,
		reviewEffort: "low",
		favoriteModels: [MODEL],
		recentModels: [MODEL],
		disabledExtensions: ["ext"],
		customLayoutPresets: [],
	},
	"v0.3.1": {
		theme: "dark",
		themeMode: "fixed",
		analyticsEnabled: false,
		analyticsConsentConfirmed: true,
		notificationsEnabled: true,
		terminalReplayKb: 256,
		terminalWindowsShell: "auto",
		composerGrowthLimit: "half-chat",
		chatLineWidth: 80,
		fileLineWidth: 90,
		chatLineWidthBounded: false,
		fileLineWidthBounded: true,
		customLayoutPresets: [],
		favoriteModels: [MODEL],
		recentModels: [],
		settleIdleDays: null,
		disabledPackages: ["pkg"],
		locale: "de",
		onboardingDismissed: true,
		interfaceFont: { family: null, fallbacks: [] },
		codeFont: { family: { name: "Fira Code" }, fallbacks: [] },
		codeFontSize: 14,
		codeLigatures: true,
		fontWeightOffset: 0,
		futureField: "kept as stored",
	},
};

const ProjectCheck = compile(Project);
const WorkspaceCheck = compile(Workspace);
const ConfigCheck = compile(AppConfig);

test.each(
	Object.entries(PROJECTS),
)("projects.json from %s loads whole and survives a save", (_, entry) => {
	write("projects.json", [entry]);
	const loaded = loadProjects();
	expect(loaded).toEqual([entry] as never);
	expect(ProjectCheck.check(loaded[0])).toBe(true);
	saveProjects(loaded);
	expect(loadProjects()).toEqual([entry] as never);
	noCopies();
});

test("a project stored with no slug keeps loading, for the owner to heal", () => {
	const { slug: _slug, ...withoutSlug } = PROJECTS["v0.0.1"];
	write("projects.json", [withoutSlug]);
	expect<unknown>(loadProjects()).toEqual([{ ...withoutSlug, slug: "" }]);
	noCopies();
});

test.each(
	Object.entries(WORKSPACES),
)("workspaces.json from %s loads whole and survives a save", (_, entry) => {
	write("workspaces.json", [entry]);
	const loaded = loadWorkspaces();
	expect(loaded).toEqual([entry] as never);
	expect(WorkspaceCheck.check(loaded[0])).toBe(true);
	saveWorkspaces(loaded);
	expect(loadWorkspaces()).toEqual([entry] as never);
	noCopies();
});

test.each(
	Object.entries(CONFIGS),
)("config.json from %s keeps its values and passes the wire check", (_, stored) => {
	write("config.json", stored);
	const loaded = loadConfig();
	expect(ConfigCheck.check(loaded)).toBe(true);
	const {
		chatMessageOrder: _order,
		layout: _layout,
		themeMode: _mode,
		...kept
	} = stored as Record<string, unknown>;
	const models = (value: unknown) =>
		Array.isArray(value) ? value.map((model) => model.id) : value;
	for (const [key, value] of Object.entries(kept)) {
		const actual = (loaded as Record<string, unknown>)[key];
		if (key.endsWith("Models")) expect(models(actual)).toEqual(models(value));
		else if (key.endsWith("Model")) expect(actual).toMatchObject(value as object);
		else expect(actual).toEqual(value);
	}
	saveConfig(loaded);
	expect(loadConfig()).toEqual(loaded);
	noCopies();
});

test("a stored model with its identity but a partial snapshot stays usable on the wire", () => {
	write("config.json", {
		defaultModel: MODEL_WITHOUT_LEVELS,
		reviewModel: { provider: "anthropic", id: "opus" },
		favoriteModels: [MODEL_WITHOUT_LEVELS],
		recentModels: [{ provider: "anthropic", id: "opus" }],
	});
	const loaded = loadConfig();
	expect(ConfigCheck.check(loaded)).toBe(true);
	expect(loaded.defaultModel).toEqual({ ...MODEL_WITHOUT_LEVELS, thinkingLevels: [] });
	expect(loaded.reviewModel?.id).toBe("opus");
	expect(loaded.favoriteModels.map((model) => model.id)).toEqual(["opus"]);
	expect(loaded.recentModels.map((model) => model.id)).toEqual(["opus"]);
	noCopies();
});

test("the other state files of v0.3.1 load unchanged", () => {
	const turn = {
		id: "t",
		workspaceId: asWorkspaceId("w"),
		sessionId: asSessionId("s"),
		startedAt: 1,
		settledAt: 2,
		baseTree: "a",
		headTree: "b",
		changes: [
			{ path: "a.ts", status: "modified", added: 1, removed: 2 },
			{ path: "b.ts", status: "deleted" },
		],
	};
	const turns = { version: 1, byWorkspace: { w: [turn] } };
	const receipts = {
		version: 1,
		baselineComplete: true,
		handledCompletionBySession: { s: "c" },
	};
	const lifecycle = {
		version: 1,
		completionBySession: {
			s: { runId: "r", completion: { completionId: "c", outcome: "succeeded" } },
			f: { runId: "r2", completion: { completionId: "c2", outcome: "failed", failure: "length" } },
		},
		cancelledRunBySession: { s: "r" },
	};
	const terminals = {
		w: [
			{ tabKey: "tab", title: "Terminal", recorded: "output" },
			{ tabKey: "tab-2", title: "Other" },
		],
	};
	const environment = { agentDir: "/agent", vars: [{ name: "A", value: "1" }] };
	write("turns.json", turns);
	write("session-receipts.json", receipts);
	write("session-lifecycle.json", lifecycle);
	write("terminals.json", terminals);
	write("environment.json", environment);
	write("installation.json", { id: "install", appInstalled: true });

	expect(loadTurns()).toEqual(turns as never);
	expect(loadSessionReceipts()).toEqual({ kind: "loaded", value: receipts } as never);
	expect(loadSessionLifecycle()).toEqual({ kind: "loaded", value: lifecycle } as never);
	expect(loadTerminalSessions()).toEqual(terminals);
	expect(loadHostEnvironment()).toEqual(environment);
	expect(ensureInstallation()).toEqual({ id: "install" });
	expect(claimAppInstalled()).toBe(false);
	noCopies();
});
