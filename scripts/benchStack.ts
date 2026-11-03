import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";

const T0 = 1_700_000_000_000;
const TREE_FILES = 2_000;
const BROWSER_CLOCK_MS = 0.1;

export interface RoundKey {
	metric: string;
	pair: string;
	build: string;
	round: number;
}

export interface SampleExtra {
	warmup?: boolean;
	note?: string;
}

export interface Sample extends RoundKey, SampleExtra {
	name: string;
	value: number | null;
	unit: string;
}

export interface Results {
	meta: Record<string, unknown>;
	batches: unknown[];
	rounds: RoundKey[];
	samples: Sample[];
	failures: Array<RoundKey & { error: string }>;
	proofs: Array<{ build: string; proof: string; value: unknown }>;
}

export interface Probe {
	frames: Array<{ key: string; sent: number | null; start: number; end: number; bytes: number }>;
	readyAt: number | null;
	welcomed: boolean;
	sessionId: string | null;
	deliver: ((raw: string) => void) | null;
}

declare global {
	interface Window {
		__bench: Probe;
	}
}

export function quantile(values: readonly number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	if (sorted.length === 0) return Number.NaN;
	const at = (sorted.length - 1) * p;
	const low = sorted[Math.floor(at)] ?? 0;
	return low + ((sorted[Math.ceil(at)] ?? 0) - low) * (at - Math.floor(at));
}

const benchId = (kind: number, i: number) =>
	`${kind}0000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

export function benchProjectId(i: number) {
	return benchId(1, i);
}

export function benchWorkspaceId(i: number) {
	return benchId(2, i);
}

export function projectEntries(dirs: readonly string[], size: number) {
	return dirs.slice(0, size).map((path, i) => ({
		id: benchProjectId(i),
		name: `project ${i}`,
		path,
		slug: `project-${i}`,
		lastOpened: T0 + i,
		trusted: true,
		acknowledgedSkills: ["review", "plan", "commit"],
		mcpApprovals: { docs: "fingerprint-a" },
	}));
}

export function workspaceEntries(dirs: readonly string[], size: number) {
	return dirs.slice(0, size).map((worktreePath, i) => ({
		id: benchWorkspaceId(i),
		projectId: benchProjectId(0),
		name: `workspace ${i}`,
		branch: `feature/${i}`,
		worktreePath,
		baseBranch: "main",
		createdAt: T0 + i,
	}));
}

export function modelEntries(size: number) {
	return Array.from({ length: size }, (_, i) => ({
		id: `model-${i}`,
		name: `Model ${i}`,
		provider: "fixture",
		contextWindow: 200_000,
		reasoning: true,
		thinkingLevels: ["off", "low", "medium", "high"],
	}));
}

export function reviewSnapshot(size: number) {
	const comments = Array.from({ length: size }, (_, i) => ({
		id: `comment-${i}`,
		reviewId: "review-0",
		kind: "inline",
		anchor: { path: `module-${i}.ts`, side: "worktree", selectors: [] },
		body: `Check the bound on line ${i}.`,
		status: "draft",
		anchorState: "anchored",
		createdAt: T0 + i,
	}));
	const baseSha = "a".repeat(40);
	const review = {
		id: "review-0",
		workspaceId: benchWorkspaceId(0),
		status: "open",
		baseSha,
		createdAt: T0,
	};
	return { review, comments };
}

export function installProbe(corrupt: string | null): void {
	const probe: Probe = {
		frames: [],
		readyAt: null,
		welcomed: false,
		sessionId: null,
		deliver: null,
	};
	window.__bench = probe;
	const sent = new Map<string, { id: string; method: string; at: number }>();
	const markReady = () => {
		if (probe.readyAt !== null || !probe.welcomed) return;
		const status = '[data-testid="connection-status"][data-status="connected"]';
		const shell = '[data-testid="add-project-menu"]';
		if (document.querySelector(status) && document.querySelector(shell)) {
			probe.readyAt = performance.now();
		}
	};
	const watched = { subtree: true, childList: true, attributes: true };
	new MutationObserver(markReady).observe(document, watched);
	class ProbeSocket extends WebSocket {
		override send(data: string) {
			const frame = JSON.parse(data);
			if (frame.id)
				sent.set(frame.id, { id: frame.id, method: String(frame.method), at: performance.now() });
			super.send(data);
		}
		override set onmessage(handler: (event: MessageEvent) => void) {
			const wrapped = (event: MessageEvent) => {
				const raw = String(event.data);
				const head = raw.slice(0, 120);
				const channel = /"channel":"([^"]+)"/.exec(head)?.[1];
				const request = sent.get(/"id":"([^"]+)"/.exec(head)?.[1] ?? "");
				const start = performance.now();
				const data = JSON.stringify({ id: request?.id, ok: true, result: "corrupt" });
				handler(
					corrupt && request?.method === corrupt ? new MessageEvent("message", { data }) : event,
				);
				const end = performance.now();
				const key = request?.method ?? channel ?? "other";
				probe.frames.push({ key, sent: request?.at ?? null, start, end, bytes: raw.length });
				if (channel === "server.welcome") probe.welcomed = true;
				if (key === "session.create") {
					probe.sessionId = /"sessionId":"([^"]+)"/.exec(raw)?.[1] ?? null;
				}
				markReady();
			};
			probe.deliver = (raw) => wrapped(new MessageEvent("message", { data: raw }));
			super.onmessage = wrapped;
		}
	}
	window.WebSocket = ProbeSocket;
}

export function playBurst({ sessionId, marker }: { sessionId: string; marker: string }) {
	const frames: string[] = [];
	const push = (event: unknown) =>
		frames.push(JSON.stringify({ channel: "pi.event", data: { sessionId, event } }));
	const shell = {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "bench",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
		stopReason: "stop",
		timestamp: 0,
	};
	const unit = "stream row measure scroll virtual anchor ";
	const tool = { toolName: "bash", args: { command: "ls" } };
	const output = (text: string) => ({ content: [{ type: "text", text }], details: {} });
	const update = (message: unknown, assistantMessageEvent: unknown) =>
		push({ type: "message_update", message, assistantMessageEvent });
	push({ type: "agent_start" });
	for (let turn = 0; turn < 10; turn += 1) {
		let text = turn === 9 ? `${marker} ` : "";
		const toolCallId = `tool-${turn}`;
		push({ type: "turn_start" });
		push({ type: "message_start", message: shell });
		update(shell, { type: "text_start", contentIndex: 0, partial: shell });
		for (let index = 0; index < 200; index += 1) {
			text += unit;
			const partial = { ...shell, content: [{ type: "text", text }] };
			update(partial, { type: "text_delta", contentIndex: 0, delta: unit, partial });
		}
		const final = { ...shell, content: [{ type: "text", text }] };
		update(final, { type: "done", reason: "stop", message: final });
		push({ type: "message_end", message: final });
		push({ type: "tool_execution_start", toolCallId, ...tool });
		for (let index = 0; index < 20; index += 1) {
			const partialResult = output(unit.repeat(index + 1));
			push({ type: "tool_execution_update", toolCallId, ...tool, partialResult });
		}
		const result = output(unit);
		push({ type: "tool_execution_end", toolCallId, ...tool, result, isError: false });
		push({ type: "turn_end", message: final, toolResults: [] });
	}
	push({ type: "agent_end", messages: [], willRetry: false });
	push({ type: "agent_settled", terminal: null });
	const deliver = window.__bench.deliver;
	if (!deliver) throw new Error("no socket handler captured");
	const stats = { frames: frames.length, handlerMs: 0, dropped: 0, animationFrames: 0 };
	return new Promise<typeof stats>((done) => {
		let index = 0;
		let previous = 0;
		let running = true;
		const onFrame = (at: number) => {
			if (previous > 0) stats.dropped += Math.max(0, Math.round(((at - previous) * 60) / 1000) - 1);
			previous = at;
			stats.animationFrames += 1;
			if (running) requestAnimationFrame(onFrame);
		};
		requestAnimationFrame(onFrame);
		const step = () => {
			const start = performance.now();
			for (const frame of frames.slice(index, index + 4)) deliver(frame);
			stats.handlerMs += performance.now() - start;
			index += 4;
			if (index < frames.length) return void setTimeout(step, 0);
			setTimeout(() => {
				running = false;
				done(stats);
			}, 300);
		};
		step();
	});
}

function statsOf(samples: readonly Sample[]) {
	const values = samples.flatMap((sample) => (sample.value === null ? [] : [sample.value]));
	return {
		median: quantile(values, 0.5),
		p25: quantile(values, 0.25),
		p75: quantile(values, 0.75),
		lost: samples.length - values.length,
	};
}

function show(value: number): string {
	if (!Number.isFinite(value)) return "-";
	if (Math.abs(value) >= 1000) return Math.round(value).toLocaleString("en-US");
	return value.toFixed(Math.abs(value) >= 10 ? 1 : 3);
}

function reportRow(samples: readonly Sample[], name: string): string[] {
	const pick = (pair: string, build: string) =>
		statsOf(samples.filter((s) => s.name === name && s.pair === pair && s.build === build));
	const count = samples.filter((s) => s.name === name && s.pair === "main").length;
	const [base, top, a1, a2] = [
		pick("main", "base"),
		pick("main", "top"),
		pick("control", "A1"),
		pick("control", "A2"),
	];
	if (count === 0) return [];
	const delta = top.median - base.median;
	const unit = samples.find((s) => s.name === name)?.unit;
	const clock = unit === "frames" ? 1 : name.endsWith(".handler") ? BROWSER_CLOCK_MS : 0;
	const halfSpread = (a1.p75 - a1.p25 + a2.p75 - a2.p25) / 4;
	const noise = Math.max(Math.abs(a1.median - a2.median), halfSpread, clock);
	const quiet = Math.abs(delta) <= noise ? "no measurable change" : "over noise";
	const measured = base.lost > 0 ? "base gave no reply" : quiet;
	const verdict = unit === "B" ? "exact" : count <= 2 ? "one run" : measured;
	const single = count <= 2;
	const percent =
		base.median === 0 || base.lost > 0 ? "-" : `${((delta / base.median) * 100).toFixed(1)}%`;
	const spread = ({ p25, p75 }: typeof base) =>
		single || !Number.isFinite(p25) ? "-" : `${show(p25)}\u2011${show(p75)}`;
	const lost = ({ lost: n }: typeof base) => (n > 0 ? ` (${n} no reply)` : "");
	return [
		`| ${name} (${unit}) | ${show(base.median)}${lost(base)} | ${show(top.median)}${lost(top)} | ${show(delta)} | ${percent} | ${spread(base)} | ${spread(top)} | ${show(noise)} | ${verdict} |`,
	];
}

export function formatReport(results: Results): string {
	const measured = results.samples.filter((sample) => !sample.warmup);
	return [
		"| metric | base median | top median | delta | delta % | base p25-p75 | top p25-p75 | A-vs-A noise | verdict |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
		...[...new Set(measured.map((s) => s.name))].flatMap((name) => reportRow(measured, name)),
	].join("\n");
}

export interface Timed {
	reply: { ok?: boolean; result?: unknown; error?: string; errorCode?: string };
	ms: number;
	bytes: number;
}

export function freePort(): Promise<number> {
	return new Promise((done, fail) => {
		const server = createServer();
		server.once("error", fail);
		server.listen(0, "localhost", () => {
			const address = server.address();
			server.close(() => done(typeof address === "object" && address ? address.port : 0));
		});
	});
}

export function createFixtures(repoPath: string, projectDirs: readonly string[]): void {
	fs.mkdirSync(repoPath, { recursive: true });
	for (const dir of projectDirs) fs.mkdirSync(dir, { recursive: true });
	for (let i = 0; i < TREE_FILES; i += 1) {
		fs.writeFileSync(join(repoPath, `module-${i}.ts`), `export const value${i} = ${i};\n`);
	}
	const identity = ["-c", "user.name=bench", "-c", "user.email=bench@example.test"];
	for (const command of ["init -q -b main", "add .", "commit -qm fixture"]) {
		const gitArgs = [...identity, ...command.split(" ")];
		const run = spawnSync("git", gitArgs, { cwd: repoPath, stdio: "ignore" });
		if (run.status !== 0) throw new Error(`git ${command} failed`);
	}
}

export function writeData(dataDir: string, file: string, value: unknown): void {
	fs.mkdirSync(dirname(join(dataDir, file)), { recursive: true });
	fs.writeFileSync(join(dataDir, file), JSON.stringify(value));
}

export function openWire(port: number, protocol: number) {
	const pending = new Map<string, { done: (timed: Timed) => void; at: number }>();
	const client = `bench-${crypto.randomUUID()}`;
	const socket = new WebSocket(`ws://localhost:${port}/ws?client=${client}&protocol=${protocol}`);
	const lost: Timed = { reply: { error: "socket closed" }, ms: -1, bytes: 0 };
	let seq = 0;
	let welcome: unknown;
	const welcomed = new Promise<void>((done) => {
		socket.addEventListener("message", (event) => {
			const raw = String(event.data);
			const at = performance.now();
			const message = JSON.parse(raw);
			if (message.channel === "server.welcome") {
				welcome = message.data;
				done();
			}
			if (typeof message.id !== "string") return;
			socket.send(JSON.stringify({ ack: [message.id] }));
			const entry = pending.get(message.id);
			pending.delete(message.id);
			entry?.done({ reply: message, ms: at - entry.at, bytes: raw.length });
		});
	});
	socket.addEventListener("close", () => {
		for (const entry of pending.values()) entry.done(lost);
		pending.clear();
	});
	function sendRaw(frameOf: (id: string) => string): Promise<Timed> {
		seq += 1;
		const id = `bench_${seq}`;
		const frame = frameOf(id);
		if (socket.readyState !== WebSocket.OPEN) return Promise.resolve(lost);
		return new Promise((done) => {
			pending.set(id, { at: performance.now(), done });
			socket.send(frame);
		});
	}
	const request = (method: string, params: unknown) =>
		sendRaw((id) => JSON.stringify({ id, method, params }));
	return { welcomed, welcome: () => welcome, sendRaw, request, close: () => socket.close() };
}

export type Wire = ReturnType<typeof openWire>;

export function field(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null
		? Object.entries(value).find(([name]) => name === key)?.[1]
		: undefined;
}

export function countOf(value: unknown): number | null {
	return Array.isArray(value) ? value.length : null;
}
