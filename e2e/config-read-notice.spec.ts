import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { toolHomeEnv } from "@thinkrail/shared/toolHomes";
import { hermeticE2ePath, hermeticE2eShell, resolveBunExecutable } from "./fixtures/executables";
import {
	E2E_FAKE_BIN_DIR,
	E2E_RESTART_DATA_DIR,
	E2E_RESTART_HOST_LOG,
	E2E_RESTART_PORT,
} from "./fixtures/paths";
import { E2eWire } from "./fixtures/wire";

const BASE = `http://localhost:${E2E_RESTART_PORT}`;
const CONFIG_PATH = join(E2E_RESTART_DATA_DIR, "config.json");
const HOME_DIR = join(E2E_RESTART_DATA_DIR, "home");
const NOTICE = "Your settings could not be read from config.json";
const rootDir = fileURLToPath(new URL("..", import.meta.url));

let host: ChildProcess | null = null;

async function startHost(): Promise<void> {
	const log = openSync(E2E_RESTART_HOST_LOG, "a");
	host = spawn(resolveBunExecutable(), ["packages/server/src/dev.ts"], {
		cwd: rootDir,
		stdio: ["ignore", log, log],
		env: {
			...process.env,
			THINKRAIL_PORT: String(E2E_RESTART_PORT),
			THINKRAIL_STATIC_DIR: join(rootDir, "apps", "web", "dist"),
			THINKRAIL_DATA_DIR: E2E_RESTART_DATA_DIR,
			THINKRAIL_GH_OFFLINE: "1",
			...toolHomeEnv(HOME_DIR),
			PI_CODING_AGENT_DIR: join(E2E_RESTART_DATA_DIR, "pi-agent"),
			PI_OFFLINE: "1",
			PATH: hermeticE2ePath(E2E_FAKE_BIN_DIR),
			SHELL: hermeticE2eShell(E2E_FAKE_BIN_DIR),
			CI: "1",
		},
	});
	await expect
		.poll(
			() =>
				fetch(`${BASE}/health`).then(
					(reply) => reply.ok,
					() => false,
				),
			{
				timeout: 60_000,
			},
		)
		.toBe(true);
}

test.beforeEach(async () => {
	rmSync(E2E_RESTART_DATA_DIR, { recursive: true, force: true });
	rmSync(E2E_RESTART_HOST_LOG, { force: true });
	mkdirSync(HOME_DIR, { recursive: true });
	mkdirSync(CONFIG_PATH);
	await startHost();
});

test.afterEach(async () => {
	const proc = host;
	host = null;
	if (proc && proc.exitCode === null) {
		const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
		proc.kill("SIGKILL");
		await exited;
	}
	rmSync(E2E_RESTART_DATA_DIR, { recursive: true, force: true });
});

test("an unreadable config.json shows one notice that a fixed file removes", async ({
	page,
	context,
}) => {
	const notice = page.getByTestId("toast").filter({ hasText: NOTICE });
	await page.goto(BASE);
	await expect(notice).toHaveCount(1);
	await expect(notice).toHaveAttribute("data-variant", "warning");
	await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
	await expect(notice).toHaveCount(1);

	rmSync(CONFIG_PATH, { recursive: true });
	writeFileSync(
		CONFIG_PATH,
		JSON.stringify({ analyticsEnabled: false, analyticsConsentConfirmed: true }),
	);

	const fresh = await context.newPage();
	await fresh.goto(BASE);
	await expect(fresh.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
	await expect(fresh.getByTestId("toast").filter({ hasText: NOTICE })).toHaveCount(0);
	await expect(notice).toHaveCount(0);

	const wire = await E2eWire.connect(E2E_RESTART_PORT);
	try {
		const config = await wire.request("settings.update", { config: {} });
		expect(config).toMatchObject({ analyticsConsentConfirmed: true });
	} finally {
		wire.close();
	}
});
