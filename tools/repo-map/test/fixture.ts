import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SymbolId } from "../core/types";
import { GitError } from "../git";

export function symbolId(id: string) {
	return id as SymbolId;
}

export interface FixtureRepo {
	root: string;
	write: (files: Record<string, string>) => void;
	remove: (path: string) => void;
	commit: (message: string) => string;
	git: (...args: string[]) => string;
	dispose: () => void;
}

const ENV = {
	GIT_AUTHOR_NAME: "fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.com",
	GIT_COMMITTER_NAME: "fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.com",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
};

export const BASE_FILES: Record<string, string> = {
	".gitignore": "node_modules/\n",
	"package.json": JSON.stringify({ name: "fx-root", private: true, workspaces: ["packages/*"] }),
	"tsconfig.json": "{}\n",
	"packages/contracts/package.json": JSON.stringify({
		name: "@fx/contracts",
		exports: { ".": "./src/index.ts" },
	}),
	"packages/contracts/SPEC.md": `---
id: fx-contracts
title: Fixture contracts
---

## Responsibility

The wire types of the fixture. Nothing else lives here.

## Boundary

- none
`,
	"packages/contracts/src/index.ts": `export const WS_METHODS = {
	ping: "sys.ping",
	echo: "sys.echo",
	orphan: "sys.orphan",
} as const;

export const WS_CHANNELS = {
	tick: "sys.tick",
	silent: "sys.silent",
} as const;

export type WsMethodName = (typeof WS_METHODS)[keyof typeof WS_METHODS];
`,
	"packages/server/package.json": JSON.stringify({
		name: "@fx/server",
		exports: { ".": "./src/index.ts" },
	}),
	"packages/server/src/index.ts": `export { dispatch } from "./handlers";
export { formatEcho } from "./format";
`,
	"packages/server/src/format.ts": `export function formatEcho(text: string) {
	return text.trim();
}

export function unusedHelper(a: number) {
	const doubled = a * 2;
	const tripled = a * 3;
	return doubled + tripled;
}
`,
	"packages/server/src/handlers.ts": `import type { WsMethodName } from "@fx/contracts";
import { formatEcho } from "./format";

type Handlers = { [M in WsMethodName]: (params: unknown) => unknown };

const handlers: Handlers = {
	"sys.ping": () => "pong",
	"sys.echo": (params) => formatEcho(String(params)),
	"sys.orphan": () => null,
};

export function dispatch(method: WsMethodName, params: unknown) {
	return handlers[method](params);
}
`,
	"packages/server/src/publish.ts": `import { WS_CHANNELS } from "@fx/contracts";

export function publishTick(server: { publish(channel: string, data: string): void }) {
	server.publish(WS_CHANNELS.tick, "1");
}

export function attach(socket: { subscribe(channel: string): void }) {
	socket.subscribe(WS_CHANNELS.silent);
}
`,
	"packages/server/src/tools.ts": `import { formatEcho } from "./format";

export function registerPing(pi: { registerTool(tool: unknown): void }) {
	pi.registerTool({
		name: "ping_tool",
		parameters: {},
		execute() {
			return formatEcho("ping");
		},
	});
	pi.registerTool({
		name: "lonely_tool",
		parameters: {},
		execute: () => 1,
	});
}
`,
	"packages/ui/package.json": JSON.stringify({
		name: "@fx/ui",
		exports: { "./button": "./button.tsx" },
	}),
	"packages/ui/button.tsx": `export function Button() {
	return <button />;
}

export function legacyLabel() {
	return "legacy";
}
`,
	"packages/web/package.json": JSON.stringify({ name: "@fx/web" }),
	"packages/web/tsconfig.json": JSON.stringify({
		compilerOptions: { paths: { "@/*": ["./src/*"] } },
	}),
	"packages/web/src/transport.ts": `import type { WsMethodName } from "@fx/contracts";

export class WsTransport {
	request<M extends WsMethodName>(method: M, params: unknown): Promise<unknown> {
		return Promise.resolve([method, params]);
	}

	subscribe(channel: string, handler: (data: unknown) => void): () => void {
		handler(channel);
		return () => {};
	}
}

let transport: WsTransport | null = null;

export function getTransport() {
	transport ??= new WsTransport();
	return transport;
}
`,
	"packages/web/src/api.ts": `import type { WsMethodName } from "@fx/contracts";
import { getTransport } from "./transport";

const fakeLocks = { request: (name: string) => name };

export function ping() {
	return getTransport().request("sys.ping", {});
}

function send<M extends "sys.echo" | "sys.ping">(method: M, params: unknown) {
	return getTransport().request(method, params);
}

export function echo(text: string) {
	return send("sys.echo", text);
}

export function lockName() {
	return fakeLocks.request("sys.orphan");
}

export function either(flag: boolean) {
	const method = flag ? "sys.ping" : "sys.echo";
	return getTransport().request(method, {});
}

export function untraced(method: WsMethodName) {
	return getTransport().request(method, {});
}
`,
	"packages/web/src/subscribe.ts": `import { WS_CHANNELS } from "@fx/contracts";
import { getTransport } from "./transport";

export function listenTick(run: (data: unknown) => void) {
	return getTransport().subscribe(WS_CHANNELS.tick, run);
}
`,
	"packages/web/src/toolRegistry.ts": `const registry = new Map<string, unknown>();

export function registerToolRenderer(name: string, renderer: unknown) {
	registry.set(name, renderer);
}
`,
	"packages/web/src/register.ts": `import { PingCard } from "./App";
import { registerToolRenderer } from "./toolRegistry";

registerToolRenderer("ping_tool", PingCard);

for (const name of ["other_tool", "another_tool"]) {
	registerToolRenderer(name, PingCard);
}
`,
	"packages/web/src/clock.ts": `export interface Clock {
	now(): number;
	label: () => string;
}

export class SystemClock implements Clock {
	now() {
		return Date.now();
	}
	label = () => "system";
}

export const fixedClock: Clock = {
	now: () => 1,
	label: () => "fixed",
};

export function readClock(clock: Clock) {
	return clock.now();
}
`,
	"packages/web/src/App.tsx": `import { Button, legacyLabel } from "@fx/ui/button";
import { ping } from "@/api";
import { lazy } from "./lazyShim";

const Panel = lazy(() => import("./Panel"));

export function PingCard() {
	return <Card />;
}

function Card() {
	return (
		<div onClick={() => ping()}>
			<Button />
			<Panel />
			{legacyLabel()}
		</div>
	);
}

export const useThing = () => ping();
`,
	"packages/web/src/globals.ts": `declare global {
	interface Window {
		fixtureFlag: boolean;
	}
}

export function hostOf(target: Window) {
	return target;
}
`,
	"packages/web/src/lazyShim.ts": `export function lazy<T>(load: () => Promise<T>) {
	return load;
}
`,
	"packages/web/src/Panel.tsx": `export default function Panel() {
	return <section />;
}
`,
	"packages/web/src/store.ts": `import { create } from "./createStore";

interface StoreState {
	count: number;
	bump: () => void;
}

export const useStore = create<StoreState>((set) => ({
	count: 0,
	bump: () => set({ count: 1 }),
}));
`,
	"packages/web/src/createStore.ts": `export function create<T>(init: (set: (next: Partial<T>) => void) => T) {
	return init(() => {});
}
`,
	"packages/web/src/index.ts": `export { echo, ping } from "./api";
`,
	"packages/web/src/api.test.ts": `import { echo, lockName, ping } from "./api";

export function pingSmoke() {
	return ping();
}

export function echoSmoke() {
	return echo("x");
}

export function lockSmoke() {
	return lockName();
}
`,
};

const WORKSPACE_LINKS = ["contracts", "server", "ui", "web"];

function linkWorkspaces(root: string) {
	mkdirSync(join(root, "node_modules/@fx"), { recursive: true });
	for (const name of WORKSPACE_LINKS) {
		symlinkSync(`../../packages/${name}`, join(root, "node_modules/@fx", name));
	}
}

export function createFixtureRepo(files: Record<string, string> = BASE_FILES): FixtureRepo {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "repo-map-fixture-")));
	const git = (...args: string[]) => {
		const result = Bun.spawnSync(["git", ...args], {
			cwd: root,
			env: { ...process.env, ...ENV },
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0) throw new GitError(args, result.stderr.toString());
		return result.stdout.toString();
	};
	const write = (updates: Record<string, string>) => {
		for (const [path, text] of Object.entries(updates)) {
			const absolute = join(root, path);
			mkdirSync(dirname(absolute), { recursive: true });
			writeFileSync(absolute, text);
		}
	};
	git("init", "--quiet", "--initial-branch=main");
	write(files);
	linkWorkspaces(root);
	return {
		root,
		git,
		write,
		remove: (path) => rmSync(join(root, path), { force: true }),
		commit: (message) => {
			git("add", "-A");
			git("commit", "--quiet", "--no-gpg-sign", "-m", message);
			return git("rev-parse", "HEAD").trim();
		},
		dispose: () => rmSync(root, { recursive: true, force: true }),
	};
}
