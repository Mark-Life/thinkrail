// Independently authored fake of the `gh` surface the host invokes; contract in e2e/SPEC.md.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import {
	arr,
	bool,
	compile,
	int,
	map,
	nullable,
	obj,
	oneOf,
	opt,
	type Static,
	str,
	unknown,
} from "@earendil-works/pi-schema";

const FakePrState = oneOf(["OPEN", "CLOSED", "MERGED"]);
export type FakePrState = Static<typeof FakePrState>;

const FakePr = obj(
	{
		number: int(),
		headRefName: str(),
		baseRefName: opt(str()),
		state: FakePrState,
		isDraft: opt(bool()),
		reviewDecision: opt(str()),
		mergeStateStatus: opt(str()),
		statusCheckRollup: opt(arr(map(unknown()))),
		latestReviews: opt(arr(obj({ author: obj({ login: str() }), state: str() }))),
		mergedAt: opt(nullable(str())),
		closedAt: opt(nullable(str())),
		createdAt: opt(str()),
		mergeError: opt(str()),
		queued: opt(bool()),
		mergedWith: opt(str()),
		headOwner: opt(str()),
	},
	{ open: true },
);
export type FakePr = Static<typeof FakePr>;

const FakeGhScenario = obj(
	{
		repo: opt(
			obj(
				{
					mergeCommitAllowed: opt(bool()),
					squashMergeAllowed: opt(bool()),
					rebaseMergeAllowed: opt(bool()),
					deleteBranchOnMerge: opt(bool()),
				},
				{ open: true },
			),
		),
		prs: arr(FakePr),
	},
	{ open: true },
);
export type FakeGhScenario = Static<typeof FakeGhScenario>;
const FakeGhScenarioFile = compile(FakeGhScenario);

export function readFakeGhScenario(path: string): FakeGhScenario {
	const scenario: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!FakeGhScenarioFile.check(scenario)) throw new Error(`${path} is not a fake gh scenario`);
	return scenario;
}

function readOrigin() {
	try {
		return execFileSync("git", ["remote", "get-url", "--push", "origin"], {
			encoding: "utf8",
		}).trim();
	} catch {
		return "";
	}
}

function fail(message: string): never {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

function main(): void {
	const [scenarioPath, logPath, ...argv] = process.argv.slice(2);
	if (!scenarioPath || !logPath) fail("fake gh: missing scenario or log path");
	appendFileSync(logPath, `${JSON.stringify(argv)}\n`);
	if (!existsSync(scenarioPath))
		fail("gh: To get started with GitHub CLI, please run: gh auth login");
	const scenario = readFakeGhScenario(scenarioPath);
	const flag = (name: string) => {
		const index = argv.indexOf(name);
		return index >= 0 ? argv[index + 1] : undefined;
	};
	const project = (row: Record<string, unknown>) => {
		const fields = (flag("--json") ?? "").split(",").filter(Boolean);
		return Object.fromEntries(fields.map((field) => [field, row[field] ?? null]));
	};
	const origin = readOrigin();
	const slug = /github\.com[:/](.+?)(?:\.git)?$/.exec(origin)?.[1] ?? "acme/sample";
	const [owner = "", name = ""] = slug.split("/");
	const shape = (pr: FakePr): Record<string, unknown> => ({
		headRepositoryOwner: { id: "U_owner", login: pr.headOwner ?? owner },
		headRepository: { id: "R_repo", name },
		url: `https://github.com/${slug}/pull/${pr.number}`,
		baseRefName: "main",
		isDraft: false,
		reviewDecision: "",
		mergeStateStatus: "CLEAN",
		statusCheckRollup: [],
		latestReviews: [],
		mergedAt: null,
		closedAt: null,
		createdAt: "2026-01-01T00:00:00Z",
		...pr,
	});
	const find = (selector: string | undefined) =>
		scenario.prs.find((pr) => String(pr.number) === selector) ??
		fail(`no pull requests found for ${selector}`);
	const save = () => writeFileSync(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`);
	const [group, command, selector] = argv;

	if (group === "repo" && command === "view") {
		const repo = {
			mergeCommitAllowed: true,
			squashMergeAllowed: true,
			rebaseMergeAllowed: true,
			deleteBranchOnMerge: false,
			...scenario.repo,
		};
		process.stdout.write(`${JSON.stringify(project(repo))}\n`);
		return;
	}
	if (group !== "pr") fail(`fake gh: unsupported command ${argv.join(" ")}`);
	switch (command) {
		case "list": {
			const head = flag("--head");
			const base = flag("--base");
			const state = (flag("--state") ?? "open").toUpperCase();
			const limit = Number(flag("--limit") ?? "30");
			const rows = scenario.prs
				.filter((pr) => pr.headRefName === head)
				.filter((pr) => base === undefined || (pr.baseRefName ?? "main") === base)
				.filter((pr) => state === "ALL" || pr.state === state)
				.sort((left, right) => right.number - left.number)
				.slice(0, limit)
				.map((pr) => project(shape(pr)));
			process.stdout.write(`${JSON.stringify(rows)}\n`);
			return;
		}
		case "view":
			process.stdout.write(`${JSON.stringify(project(shape(find(selector))))}\n`);
			return;
		case "ready": {
			const pr = find(selector);
			pr.isDraft = false;
			if (pr.mergeStateStatus === "DRAFT") pr.mergeStateStatus = "CLEAN";
			save();
			return;
		}
		case "merge": {
			const pr = find(selector);
			if (pr.mergeError) fail(pr.mergeError);
			const mergedWith = argv.find((arg) => ["--squash", "--merge", "--rebase"].includes(arg));
			if (mergedWith === undefined) delete pr.mergedWith;
			else pr.mergedWith = mergedWith;
			if (!pr.queued) {
				pr.state = "MERGED";
				pr.mergedAt = new Date().toISOString();
			}
			save();
			return;
		}
		case "reopen": {
			const pr = find(selector);
			pr.state = "OPEN";
			pr.closedAt = null;
			save();
			return;
		}
		default:
			fail(`fake gh: unsupported command ${argv.join(" ")}`);
	}
}

if (import.meta.main) main();
