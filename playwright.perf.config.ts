import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { resolveBunExecutable } from "./e2e/fixtures/executables";
import base from "./playwright.config";

const server = base.webServer;
if (!server || Array.isArray(server)) throw new Error("perf config expects one e2e webServer");

const appRoot = process.env.THINKRAIL_PERF_APP_ROOT;
const browser = process.env.THINKRAIL_PERF_BROWSER ?? "chromium";
if (browser !== "chromium" && browser !== "webkit") {
	throw new Error(`THINKRAIL_PERF_BROWSER must be chromium or webkit, got ${browser}`);
}

const profileDir = appRoot
	? join(appRoot, "apps/web/dist-profile")
	: fileURLToPath(new URL("./apps/web/dist-profile", import.meta.url));
const bun = JSON.stringify(resolveBunExecutable());
const host = appRoot
	? `${bun} ${JSON.stringify(join(appRoot, "packages/server/src/dev.ts"))}`
	: `${bun} packages/server/src/dev.ts`;
const skipBuild = appRoot !== undefined || process.env.THINKRAIL_E2E_SKIP_BUILD === "1";

const project =
	browser === "webkit"
		? { name: "webkit", use: { ...devices["Desktop Safari"] } }
		: {
				name: "chromium",
				use: {
					...devices["Desktop Chrome"],
					launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] },
				},
			};

export default defineConfig({
	...base,
	testDir: "./e2e/perf",
	testMatch: "**/*.perf.ts",
	testIgnore: [],
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 180_000,
	reporter: "list",
	projects: [project],
	webServer: {
		...server,
		...(appRoot ? { cwd: appRoot } : {}),
		command: skipBuild ? host : `${bun} run --cwd apps/web build:profile && ${host}`,
		env: { ...server.env, THINKRAIL_STATIC_DIR: profileDir },
	},
});
