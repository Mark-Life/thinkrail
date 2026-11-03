import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile, num } from "@earendil-works/pi-schema";
import { asProjectId, DEFAULT_CONFIG } from "@thinkrail/contracts";
import type { CodedError } from "@thinkrail/shared/codedError";
import {
	loadConfig,
	loadHostEnvironment,
	loadProjects,
	loadTerminalSessions,
	loadWorkspaces,
	observeStateFileProblems,
	parseEntryRecord,
	readStateFile,
	saveConfig,
	saveProjects,
} from "./persistence";

const savedDataDir = process.env.THINKRAIL_DATA_DIR;
const project = (id: string) => ({
	id: asProjectId(id),
	name: id,
	path: `/repo/${id}`,
	slug: id,
	lastOpened: 1,
});
let root: string;
let problems: CodedError[];

const copies = () => readdirSync(root).filter((name) => name.includes(".corrupt-"));

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "thinkrail-state-file-"));
	process.env.THINKRAIL_DATA_DIR = root;
	problems = [];
	observeStateFileProblems((problem) => problems.push(problem));
});

afterEach(() => {
	observeStateFileProblems(null);
	rmSync(root, { recursive: true, force: true });
	if (savedDataDir === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = savedDataDir;
});

test("a bad entry is dropped and reported once, and the file is copied before a save can lose it", () => {
	const stored = JSON.stringify([project("a"), { id: "no-path" }, project("b")]);
	writeFileSync(join(root, "projects.json"), stored);

	expect(loadProjects().map((entry) => entry.id)).toEqual([asProjectId("a"), asProjectId("b")]);
	expect(loadProjects().map((entry) => entry.id)).toEqual([asProjectId("a"), asProjectId("b")]);

	expect(problems.map((problem) => problem.code)).toEqual(["STATE_FILE_SET_ASIDE"]);
	expect(problems[0]?.message).toContain("dropped entries 1");
	expect(problems[0]?.message).not.toContain("no-path");
	saveProjects(loadProjects());
	const [copy] = copies();
	expect(copy).toBeDefined();
	expect(readFileSync(join(root, copy ?? ""), "utf8")).toBe(stored);
});

test("no copy is made for a clean file, a missing file, or an empty list", () => {
	expect(loadProjects()).toEqual([]);
	saveProjects([project("a")]);
	expect(loadProjects()).toHaveLength(1);
	expect(copies()).toEqual([]);
	expect(problems).toEqual([]);
});

test.each([
	["projects.json", loadProjects, "{ not json", []],
	["workspaces.json", loadWorkspaces, '{"id":"not-a-list"}', []],
	["terminals.json", loadTerminalSessions, "[1]", {}],
	["environment.json", loadHostEnvironment, "null", { vars: [] }],
] as const)("%s that fails whole loads empty and keeps its bytes", (file, load, stored, empty) => {
	writeFileSync(join(root, file), stored);
	expect(load()).toEqual(empty as never);
	const [copy] = copies();
	expect(readFileSync(join(root, copy ?? ""), "utf8")).toBe(stored);
	expect(readFileSync(join(root, file), "utf8")).toBe(stored);
});

test("a config that is not JSON loads defaults, and the next save leaves the old bytes in a copy", () => {
	writeFileSync(join(root, "config.json"), '{"theme":"light",');
	expect(loadConfig()).toEqual(DEFAULT_CONFIG);
	saveConfig({ ...DEFAULT_CONFIG, chatLineWidth: 90 });
	const [copy] = copies();
	expect(readFileSync(join(root, copy ?? ""), "utf8")).toBe('{"theme":"light",');
	expect(loadConfig().chatLineWidth).toBe(90);
});

test("a copy of environment.json stays private to the user", () => {
	writeFileSync(join(root, "environment.json"), '{"vars":[{"name":"TOKEN","value":"secret"},1]}');
	expect(loadHostEnvironment().vars).toEqual([{ name: "TOKEN", value: "secret" }]);
	const [copy] = copies();
	expect(statSync(join(root, copy ?? "")).mode & 0o777).toBe(0o600);
});

test("a file that cannot be read refuses to be replaced until a read succeeds", () => {
	mkdirSync(join(root, "projects.json"));
	expect(loadProjects()).toEqual([]);
	expect(loadProjects()).toEqual([]);
	expect(problems.map((problem) => problem.code)).toEqual(["STATE_FILE_UNREADABLE"]);
	expect(() => saveProjects([project("a")])).toThrow("was not replaced");

	rmSync(join(root, "projects.json"), { recursive: true });
	expect(loadProjects()).toEqual([]);
	saveProjects([project("a")]);
	expect(loadProjects()).toHaveLength(1);
});

test("a bad entry in a model or name list leaves the rest of the config alone", () => {
	const model = {
		provider: "p",
		id: "m",
		name: "M",
		contextWindow: 1,
		reasoning: false,
		thinkingLevels: [],
	};
	writeFileSync(
		join(root, "config.json"),
		JSON.stringify({
			chatLineWidth: 90,
			favoriteModels: [model, { id: "no-provider" }, "x"],
			defaultEffort: "enormous",
			reviewModel: 7,
			disabledExtensions: ["a", 1, " ", "a"],
		}),
	);
	const config = loadConfig();
	expect(config.chatLineWidth).toBe(90);
	expect(config.favoriteModels).toEqual([model]);
	expect(config.defaultEffort).toBeUndefined();
	expect(config.reviewModel).toBeUndefined();
	expect(config.disabledExtensions).toEqual(["a"]);
	expect(copies()).toHaveLength(1);
});

test("parseEntryRecord keeps good keys, sets the bad ones aside and takes __proto__ as a plain key", () => {
	const path = join(root, "items.json");
	const raw = '{"good":1,"bad":"x","__proto__":2}';
	writeFileSync(path, raw);
	const file = readStateFile(path);
	const kept = parseEntryRecord(file, JSON.parse(raw), compile(num()));
	expect(Object.keys(kept).sort()).toEqual(["__proto__", "good"]);
	expect(Object.getPrototypeOf(kept)).toBe(Object.prototype);
	expect(readdirSync(root).filter((name) => name.includes(".corrupt-")).length).toBe(1);
	expect(problems.map((problem) => problem.code)).toEqual(["STATE_FILE_SET_ASIDE"]);
});
