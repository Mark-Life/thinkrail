import { expect, test } from "bun:test";
import { startServerRuntime } from "./serverRuntime";

const options = {
	runtimeDir: "/runtime",
	staticDir: "/static",
	appVersion: "1.0.0",
	channel: "dev",
	posthogProjectKey: "",
};

function runtime(host: unknown) {
	return { startDesktopHost: async () => host };
}

test("a runtime or host that lacks what the desktop calls fails with a coded error", async () => {
	for (const value of [
		null,
		{},
		runtime(null),
		runtime({ port: "1", reportError() {}, server: { shutdown() {}, startAttributionClaim() {} } }),
		runtime({ port: 1, reportError() {}, server: { shutdown() {} } }),
	]) {
		await expect(startServerRuntime(value, options)).rejects.toMatchObject({ code: "HOST_ERROR" });
	}
});

test("the started host forwards calls to the runtime's own functions", async () => {
	const calls: unknown[][] = [];
	const host = await startServerRuntime(
		runtime({
			port: 4321,
			reportError: (...args: unknown[]) => calls.push(["reportError", ...args]),
			server: {
				shutdown: async () => calls.push(["shutdown"]),
				startAttributionClaim: () => calls.push(["startAttributionClaim"]),
			},
		}),
		options,
	);
	host.reportError(new Error("boom"), "scope");
	await host.shutdown();
	host.startAttributionClaim();
	expect(host.port).toBe(4321);
	expect(calls.map(([name]) => name)).toEqual(["reportError", "shutdown", "startAttributionClaim"]);
});
