import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { type Browser, chromium, type Page } from "@playwright/test";
import { toolHomeEnv } from "@thinkrail/shared/toolHomes";
import {
	benchProjectId,
	benchWorkspaceId,
	countOf,
	createFixtures,
	field,
	formatReport,
	freePort,
	installProbe,
	modelEntries,
	openWire,
	playBurst,
	projectEntries,
	quantile,
	type Results,
	reviewSnapshot,
	type SampleExtra,
	type Timed,
	type Wire,
	workspaceEntries,
	writeData,
} from "./benchStack";

const USAGE = `bun scripts/bench-stack.ts run --base <checkout> --top <checkout>
  [--control] [--metric a,b] [--samples n] [--budget-s n] [--out file]
bun scripts/bench-stack.ts report --out file`;
const LARGE = 1_000;
const DEEP = 200_000;
const WIDE = 20_000;
const CONSENT = { analyticsConsentConfirmed: true, onboardingDismissed: true };

interface Build {
	label: string;
	path: string;
}

interface Round {
	build: Build;
	number: number;
	emit: (name: string, value: number | null, unit: string, extra?: SampleExtra) => void;
}

interface Metric {
	rounds: number;
	run: (round: Round) => Promise<void>;
}

const { values: flags, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		base: { type: "string" },
		top: { type: "string" },
		metric: { type: "string" },
		out: { type: "string", default: join(os.tmpdir(), "bench-stack.json") },
		control: { type: "boolean", default: false },
		"budget-s": { type: "string", default: "540" },
		samples: { type: "string" },
	},
});
const outPath = resolve(flags.out ?? "");
const runRoot = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "bench-stack-")));
const liveHosts = new Set<ChildProcess>();
let browser: Browser | null = null;

function wait(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms));
}

function saveResults(results: Results): void {
	fs.mkdirSync(dirname(outPath), { recursive: true });
	fs.writeFileSync(`${outPath}.tmp`, JSON.stringify(results, null, 1));
	fs.renameSync(`${outPath}.tmp`, outPath);
}

const repoPath = join(runRoot, "fixture-repo");
const projectDirs = Array.from({ length: LARGE }, (_, i) => join(runRoot, "dirs", `project-${i}`));

async function startHost(build: Build, seed?: (dataDir: string) => void) {
	const sandbox = fs.mkdtempSync(join(runRoot, "host-"));
	const home = join(sandbox, "home");
	const dataDir = join(sandbox, "data");
	fs.mkdirSync(home);
	writeData(dataDir, "config.json", CONSENT);
	seed?.(dataDir);
	const port = await freePort();
	const startedAt = performance.now();
	const child = spawn("bun", ["--no-env-file", join(build.path, "packages/server/src/dev.ts")], {
		cwd: sandbox,
		env: {
			PATH: process.env.PATH ?? "",
			...toolHomeEnv(home),
			THINKRAIL_PORT: String(port),
			THINKRAIL_DATA_DIR: dataDir,
			THINKRAIL_STATIC_DIR: join(build.path, "apps/web/dist"),
			PI_CODING_AGENT_DIR: join(sandbox, "pi-agent"),
			THINKRAIL_NO_ANALYTICS: "1",
			THINKRAIL_GH_OFFLINE: "1",
		},
		stdio: "ignore",
	});
	liveHosts.add(child);
	const gone = new Promise<void>((done) => child.once("exit", () => done()));
	const stop = async () => {
		child.kill("SIGTERM");
		await Promise.race([gone, wait(5_000)]);
		child.kill("SIGKILL");
		await gone;
		liveHosts.delete(child);
		fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5 });
	};
	const alive = () => child.exitCode === null && child.signalCode === null;
	for (;;) {
		const health = await fetch(`http://localhost:${port}/health`).then(
			(r) => r.status,
			() => 0,
		);
		const startupMs = performance.now() - startedAt;
		if (health === 200) return { port, pid: child.pid ?? 0, startupMs, alive, stop };
		if (!alive() || startupMs > 60_000) {
			await stop();
			throw new Error(`host of ${build.label} did not answer /health`);
		}
		await wait(5);
	}
}

type Host = Awaited<ReturnType<typeof startHost>>;

async function withHost(
	build: Build,
	seed: ((dataDir: string) => void) | undefined,
	use: (host: Host) => Promise<void>,
): Promise<void> {
	const host = await startHost(build, seed);
	try {
		await use(host);
	} finally {
		await host.stop();
	}
}

async function connect(port: number): Promise<Wire> {
	const first = openWire(port, 0);
	await first.welcomed;
	first.close();
	const wire = openWire(port, Number(field(first.welcome(), "protocolVersion")));
	await wire.welcomed;
	return wire;
}

async function openRepo(wire: Wire) {
	const project = (await wire.request("project.open", { path: repoPath })).reply.result;
	const projectId = field(project, "id");
	const params = { projectId, includeDiffStats: false };
	const listed = (await wire.request("workspace.list", params)).reply.result;
	const workspaceId = field(Array.isArray(listed) ? listed[0] : null, "id");
	if (!projectId || !workspaceId) throw new Error("the fixture repo did not open");
	return { projectId, workspaceId };
}

async function openPage(host: Host, cpu: number, corrupt: string | null = null) {
	browser ??= await chromium.launch({
		args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost"],
	});
	const context = await browser.newContext();
	const page = await context.newPage();
	const warnings: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "warning") warnings.push(message.text());
	});
	await page.addInitScript(installProbe, corrupt);
	const cdp = await context.newCDPSession(page);
	await cdp.send("Performance.enable");
	const throttle = (rate: number) => cdp.send("Emulation.setCPUThrottlingRate", { rate });
	await throttle(cpu);
	const cpuMetric = async (name: string) => {
		const { metrics } = await cdp.send("Performance.getMetrics");
		return metrics.find((entry) => entry.name === name)?.value ?? 0;
	};
	const load = async () => {
		await page.goto(`http://localhost:${host.port}/`);
		await page.waitForFunction(() => window.__bench.readyAt !== null, undefined, {
			timeout: 60_000,
			polling: 50,
		});
		return (await page.evaluate(() => window.__bench.readyAt)) ?? Number.NaN;
	};
	return { page, warnings, cpuMetric, load, throttle, close: () => context.close() };
}

function loadMetric(rounds: number, cpu: number, name: string): Metric {
	return {
		rounds,
		run: ({ build, emit }) =>
			withHost(build, undefined, async (host) => {
				const warm = await openPage(host, cpu);
				emit(`${name}.connected`, await warm.load(), "ms", { warmup: true });
				await warm.close();
				const view = await openPage(host, cpu);
				emit(`${name}.connected`, await view.load(), "ms");
				await view.page.waitForTimeout(250);
				emit(`${name}.scriptMs`, (await view.cpuMetric("ScriptDuration")) * 1000, "ms");
				emit(`${name}.taskMs`, (await view.cpuMetric("TaskDuration")) * 1000, "ms");
				await view.close();
			}),
	};
}

function bundleSizes({ build, emit }: Round): void {
	const dist = join(build.path, "apps/web/dist");
	const html = fs.readFileSync(join(dist, "index.html"), "utf8");
	const entry = /<script[^>]+src="\/([^"]+\.js)"/.exec(html)?.[1];
	if (!entry) throw new Error("index.html names no entry script");
	const assets = fs.readdirSync(join(dist, "assets")).filter((file) => file.endsWith(".js"));
	const groups = { "js.total": assets.map((file) => `assets/${file}`), "js.entry": [entry] };
	for (const [name, files] of Object.entries(groups)) {
		const contents = files.map((file) => fs.readFileSync(join(dist, file)));
		const sum = (sizes: number[]) => sizes.reduce((total, size) => total + size, 0);
		emit(`${name}.bytes`, sum(contents.map((bytes) => bytes.length)), "B");
		emit(`${name}.gzip`, sum(contents.map((bytes) => gzipSync(bytes, { level: 9 }).length)), "B");
	}
}

async function badRequests({ build, emit }: Round) {
	const items = Array.from({ length: WIDE }, (_, index) => ({ index, name: `item-${index}` }));
	const wide = JSON.stringify(items);
	const deep = `${"[".repeat(DEEP)}${"]".repeat(DEEP)}`;
	const inspect = (id: string, path: string) =>
		`{"id":"${id}","method":"project.inspect","params":{"path":${path}}}`;
	const respond = `"method":"session.respondToTool","params":{"sessionId":"s","toolCallId":"t"`;
	const cases: Array<[string, number, (id: string) => string]> = [
		["badreq.small", 50, (id) => inspect(id, "123")],
		["badreq.wide1MB", 10, (id) => inspect(id, wide)],
		["badreq.deep200k", 3, (id) => `{"id":"${id}",${respond},"response":${deep}}}`],
	];
	await withHost(build, undefined, async (host) => {
		const wire = await connect(host.port);
		for (const [name, count, frameOf] of cases) {
			const replies: Timed[] = [];
			for (let i = 0; i < count; i += 1) replies.push(await wire.sendRaw(frameOf));
			const last = replies.at(-1)?.reply;
			const outcome = last?.ok ? "ok" : (last?.errorCode ?? last?.error?.slice(0, 40));
			const lost = replies.some((timed) => timed.ms < 0);
			if (lost) await wait(500);
			const value = lost
				? null
				: quantile(
						replies.map((timed) => timed.ms),
						0.5,
					);
			emit(name, value, "ms", { note: `${outcome}; host alive ${host.alive()}` });
		}
		wire.close();
	});
}

function seedLargeProjects(dataDir: string): void {
	writeData(dataDir, "projects.json", projectEntries(projectDirs, LARGE));
}

async function roundTrips({ build, emit }: Round) {
	await withHost(build, seedLargeProjects, async (host) => {
		const wire = await connect(host.port);
		const { projectId, workspaceId } = await openRepo(wire);
		const cases: Array<[string, string, unknown, number]> = [
			["small.session.stateList", "session.stateList", {}, 300],
			["params.session.list", "session.list", { workspaceId }, 300],
			["params.workspace.list", "workspace.list", { projectId, includeDiffStats: false }, 100],
			["large.project.list", "project.list", {}, 100],
			["large.fs.readDir", "fs.readDir", { workspaceId, path: "." }, 50],
		];
		for (const [name, method, params, count] of cases) {
			const warmups = Math.ceil(count / 10);
			const replies: Timed[] = [];
			for (let i = 0; i < count + warmups; i += 1) replies.push(await wire.request(method, params));
			const measured = replies.slice(warmups);
			const times = measured.map((timed) => timed.ms);
			const failed = replies.filter((timed) => !timed.reply.ok).length;
			const entries = countOf(measured.at(-1)?.reply.result);
			const note = `${measured.at(-1)?.bytes} B, ${entries} entries, ${failed} failed`;
			const warmup = quantile(
				replies.slice(0, warmups).map((timed) => timed.ms),
				0.5,
			);
			emit(`rtt.${name}.warmup`, warmup, "ms", { warmup: true });
			emit(`rtt.${name}.p50`, quantile(times, 0.5), "ms", { note });
			emit(`rtt.${name}.p95`, quantile(times, 0.95), "ms", { note });
		}
		wire.close();
	});
}

async function enterChat(page: Page): Promise<string> {
	await page.getByTestId("project-item").filter({ hasText: "fixture-repo" }).click();
	await page.getByTestId("welcome-action").filter({ hasText: "Work in project folder" }).click();
	await page.getByTestId("start-chat").click();
	await page.getByTestId("chat-input").waitFor({ state: "visible", timeout: 30_000 });
	await page.waitForFunction(() => window.__bench.sessionId !== null);
	return (await page.evaluate(() => window.__bench.sessionId)) ?? "";
}

async function browserRoundTrips({ build, emit }: Round) {
	await withHost(build, seedLargeProjects, async (host) => {
		const wire = await connect(host.port);
		await openRepo(wire);
		wire.close();
		const view = await openPage(host, 1);
		await view.load();
		await enterChat(view.page);
		await view.page.getByTestId("tool-rail-files").click();
		await view.page.waitForFunction(() =>
			window.__bench.frames.some((frame) => frame.key === "fs.readDir" && frame.bytes > 100_000),
		);
		const frames = await view.page.evaluate(() => window.__bench.frames);
		const methods = ["session.stateList", "workspace.list", "fs.readDir", "server.welcome"];
		for (const key of methods) {
			const matching = frames.filter((frame) => frame.key === key);
			const largest = Math.max(...matching.map((frame) => frame.bytes));
			const chosen = key === "fs.readDir" ? matching.filter((f) => f.bytes === largest) : matching;
			const handler = chosen.map((frame) => frame.end - frame.start);
			const note = `${chosen.length} frames, up to ${largest} B`;
			emit(`rttBrowser.${key}.handler`, quantile(handler, 0.5), "ms", { note });
			const trips = chosen.flatMap((f) => (f.sent === null ? [] : [f.end - f.sent]));
			if (trips.length > 0) emit(`rttBrowser.${key}.total`, quantile(trips, 0.5), "ms");
		}
		await view.close();
	});
}

function burstMetric(rounds: number, cpu: number, name: string): Metric {
	return {
		rounds,
		run: ({ build, number, emit }) =>
			withHost(build, undefined, async (host) => {
				const wire = await connect(host.port);
				await openRepo(wire);
				wire.close();
				const view = await openPage(host, 1);
				await view.load();
				const sessionId = await enterChat(view.page);
				await view.page.waitForTimeout(500);
				view.warnings.length = 0;
				const taskBefore = await view.cpuMetric("TaskDuration");
				const marker = `bench-marker-${number}`;
				await view.throttle(cpu);
				const played = await view.page.evaluate(playBurst, { sessionId, marker });
				const shown = (text: string) => document.body.textContent?.includes(text);
				await view.page.waitForFunction(shown, marker, { timeout: 30_000 });
				const taskMs = ((await view.cpuMetric("TaskDuration")) - taskBefore) * 1000;
				const refused = view.warnings.filter((text) => text.includes("dropped a")).length;
				const note = `${played.frames} frames rendered, ${refused} refused`;
				emit(`${name}.handlerMsPerEvent`, played.handlerMs / played.frames, "ms", { note });
				emit(`${name}.taskMsPerEvent`, taskMs / played.frames, "ms");
				const frameNote = `${played.animationFrames} animation frames`;
				emit(`${name}.droppedFrames`, played.dropped, "frames", { note: frameNote });
				await view.close();
			}),
	};
}

interface FileCase {
	seed: (dataDir: string, size: number) => void;
	first: (wire: Wire) => Promise<unknown>;
}

const FILE_CASES: Record<string, FileCase> = {
	projects: {
		seed: (dataDir, size) => writeData(dataDir, "projects.json", projectEntries(projectDirs, size)),
		first: async (wire) => (await wire.request("project.list", {})).reply.result,
	},
	workspaces: {
		seed: (dataDir, size) => {
			writeData(dataDir, "projects.json", projectEntries(projectDirs, 1));
			writeData(dataDir, "workspaces.json", workspaceEntries(projectDirs, size));
		},
		first: async (wire) => {
			const params = { projectId: benchProjectId(0), includeDiffStats: false };
			return (await wire.request("workspace.list", params)).reply.result;
		},
	},
	config: {
		seed: (dataDir, size) => {
			const models = modelEntries(size);
			writeData(dataDir, "config.json", {
				...CONSENT,
				recentModels: models,
				favoriteModels: models,
			});
		},
		first: async (wire) => field(field(wire.welcome(), "config"), "recentModels"),
	},
	reviews: {
		seed: (dataDir, size) => {
			writeData(dataDir, "projects.json", projectEntries(projectDirs, 1));
			writeData(dataDir, "workspaces.json", workspaceEntries(projectDirs, 1));
			writeData(dataDir, `reviews/${benchWorkspaceId(0)}.json`, reviewSnapshot(size));
		},
		first: async (wire) => {
			const { reply } = await wire.request("review.get", { workspaceId: benchWorkspaceId(0) });
			return field(reply.result, "comments");
		},
	},
};

function fileMetric(name: string, fileCase: FileCase, size: number): Metric {
	return {
		rounds: 15,
		run: ({ build, emit }) =>
			withHost(
				build,
				(dataDir) => fileCase.seed(dataDir, size),
				async (host) => {
					const wire = await connect(host.port);
					const firstAt = performance.now();
					const loaded = countOf(await fileCase.first(wire));
					const firstMs = performance.now() - firstAt;
					const note = `${loaded} entries from ${size}`;
					emit(`file.${name}.${size}.startup`, host.startupMs, "ms", { note });
					emit(`file.${name}.${size}.firstRequest`, firstMs, "ms", { note });
					wire.close();
				},
			),
	};
}

function timedCommand(name: string, command: string, subdir: string): Metric {
	return {
		rounds: 1,
		run: async ({ build, emit }) => {
			const [program = "", ...rest] = command.split(" ");
			const startedAt = performance.now();
			const cwd = join(build.path, subdir);
			const run = spawnSync(program, rest, { cwd, stdio: "ignore" });
			emit(name, performance.now() - startedAt, "ms", { note: `exit ${run.status}` });
		},
	};
}

async function proofs(results: Results, build: Build) {
	const record = (proof: string, value: unknown) => {
		results.proofs.push({ build: build.label, proof, value });
		saveResults(results);
	};
	record("THINKRAIL_CHECK_WS_RESULTS", process.env.THINKRAIL_CHECK_WS_RESULTS ?? "unset");
	await withHost(build, seedLargeProjects, async (host) => {
		const wire = await connect(host.port);
		const { reply } = await wire.request("project.inspect", { path: 123 });
		record("bad params reply", { ok: reply.ok, code: reply.errorCode, error: reply.error });
		record("project.list entries", countOf((await wire.request("project.list", {})).reply.result));
		wire.close();
		const view = await openPage(host, 1, "session.stateList");
		await view.load();
		const badPush = JSON.stringify({ channel: "pi.event", data: { sessionId: "bench" } });
		await view.page.evaluate((raw) => window.__bench.deliver?.(raw), badPush);
		await view.page.waitForTimeout(500);
		record("warnings on a corrupt reply and a bad pi.event", view.warnings);
		await view.close();
	});
}

function metricTable(): Record<string, Metric> {
	const table: Record<string, Metric> = {
		bundle: { rounds: 1, run: async (round) => bundleSizes(round) },
		load: loadMetric(7, 1, "load"),
		load4x: loadMetric(7, 4, "load4x"),
		startup: {
			rounds: 15,
			run: ({ build, emit }) =>
				withHost(build, undefined, async (host) => emit("startup.health", host.startupMs, "ms")),
		},
		rss: {
			rounds: 15,
			run: ({ build, emit }) =>
				withHost(build, undefined, async (host) => {
					const wire = await connect(host.port);
					await wait(3_000);
					const ps = spawnSync("ps", ["-o", "rss=", "-p", String(host.pid)], { encoding: "utf8" });
					emit("rss.idle", Number(ps.stdout.trim()) / 1024, "MB");
					wire.close();
				}),
		},
		rtt: { rounds: 15, run: roundTrips },
		rttBrowser: { rounds: 15, run: browserRoundTrips },
		badreq: { rounds: 15, run: badRequests },
		burst: burstMetric(15, 1, "burst"),
		burst4x: burstMetric(7, 4, "burst4x"),
		devTypecheck: timedCommand("dev.typecheck", "bun run typecheck --force", ""),
		devServerTsc: timedCommand("dev.serverTsc", "bun x tsc --noEmit", "packages/server"),
	};
	for (const [name, fileCase] of Object.entries(FILE_CASES)) {
		for (const size of [10, LARGE])
			table[`file.${name}.${size}`] = fileMetric(name, fileCase, size);
	}
	return table;
}

async function runMetric(
	results: Results,
	metric: string,
	entry: Metric,
	builds: Build[],
	end: number,
) {
	const pair = flags.control ? "control" : "main";
	const target = flags.samples ? Number(flags.samples) : entry.rounds;
	let failures = 0;
	for (;;) {
		const done = results.rounds.filter((key) => key.metric === metric && key.pair === pair);
		const counts = builds.map((build) => done.filter((key) => key.build === build.label).length);
		if (counts.every((count) => count >= target)) return true;
		if (performance.now() > end) return false;
		const index = counts.indexOf(Math.min(...counts));
		const build = builds[index] ?? { label: "", path: "" };
		const key = { metric, pair, build: build.label, round: counts[index] ?? 0 };
		const emit: Round["emit"] = (name, value, unit, extra) => {
			results.samples.push({ ...key, name, value, unit, ...extra });
			saveResults(results);
		};
		try {
			await entry.run({ build, number: key.round, emit });
			results.rounds.push(key);
		} catch (error) {
			failures += 1;
			results.failures.push({ ...key, error: String(error).slice(0, 500) });
			if (failures >= 3) throw new Error(`${metric}: three failed rounds: ${String(error)}`);
		}
		saveResults(results);
	}
}

async function main() {
	const results: Results = fs.existsSync(outPath)
		? JSON.parse(fs.readFileSync(outPath, "utf8"))
		: { meta: {}, batches: [], rounds: [], samples: [], failures: [], proofs: [] };
	if (positionals[0] === "report") return console.log(formatReport(results));
	if (!flags.base || !flags.top) throw new Error(USAGE);
	const [base, top] = [resolve(flags.base), resolve(flags.top)];
	const builds = flags.control
		? [
				{ label: "A1", path: base },
				{ label: "A2", path: base },
			]
		: [
				{ label: "base", path: base },
				{ label: "top", path: top },
			];
	for (const { path } of builds) {
		if (!fs.existsSync(join(path, "apps/web/dist/index.html"))) {
			throw new Error(`${path} has no web build: run bun run build:web there`);
		}
	}
	const version = (tool: string) =>
		spawnSync(tool, ["--version"], { encoding: "utf8" }).stdout.trim();
	results.meta = {
		machine: `${os.platform()} ${os.release()} ${os.arch()}, ${os.cpus()[0]?.model}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GB`,
		node: version("node"),
		bun: version("bun"),
	};
	createFixtures(repoPath, projectDirs);
	const table = metricTable();
	const selected = flags.metric?.split(",") ?? [...Object.keys(table), "proof"];
	const end = performance.now() + Number(flags["budget-s"]) * 1000;
	const remaining: string[] = [];
	for (const name of selected) {
		results.batches.push({ at: new Date().toISOString(), loadavg: os.loadavg(), metric: name });
		saveResults(results);
		if (name === "proof") {
			for (const build of builds) await proofs(results, build);
			continue;
		}
		const entry = table[name];
		if (!entry) throw new Error(`unknown metric ${name}: ${Object.keys(table).join(", ")}`);
		if (!(await runMetric(results, name, entry, builds, end))) remaining.push(name);
	}
	console.log(remaining.length > 0 ? `REMAINING ${remaining.join(",")}` : "DONE");
}

async function shutdown() {
	await browser?.close();
	for (const child of liveHosts) child.kill("SIGKILL");
	fs.rmSync(runRoot, { recursive: true, force: true, maxRetries: 5 });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => void shutdown().finally(() => process.exit(1)));
}

try {
	await main();
} finally {
	await shutdown();
}
