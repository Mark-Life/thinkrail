import { connect, createServer } from "node:net";
import { errnoCode } from "./errnoCode";

const DEFAULT_HOST = "localhost";
const PROBE_TIMEOUT_MS = 300;
const DEFAULT_SCAN_ATTEMPTS = 20;

function isConnectionRefused(err: Error): boolean {
	if (errnoCode(err) === "ECONNREFUSED") return true;
	if ("errors" in err && Array.isArray(err.errors) && err.errors.length > 0) {
		return err.errors.every((inner) => errnoCode(inner) === "ECONNREFUSED");
	}
	return false;
}

export function isPortFree(port: number, host: string = DEFAULT_HOST): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ port, host, autoSelectFamily: true });
		let settled = false;
		const finish = (free: boolean): void => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(free);
		};
		socket.setTimeout(PROBE_TIMEOUT_MS);
		socket.once("connect", () => finish(false));
		socket.once("timeout", () => finish(false));
		socket.once("error", (err) => finish(isConnectionRefused(err)));
	});
}

function osAssignedPort(host: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, host, () => {
			const address = probe.address();
			const port = typeof address === "object" && address ? address.port : 0;
			probe.close(() => resolve(port));
		});
	});
}

export async function findFreePort(
	preferred: number,
	host: string = DEFAULT_HOST,
	attempts: number = DEFAULT_SCAN_ATTEMPTS,
): Promise<number> {
	for (let port = preferred; port < preferred + attempts && port <= 65535; port += 1) {
		if (await isPortFree(port, host)) return port;
	}
	return osAssignedPort(host);
}

/** Strict port parse: plain decimal digits only, 0-65535. Anything else is undefined. */
export function parsePort(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d+$/.test(value)) return undefined;
	const port = Number(value);
	return port <= 65535 ? port : undefined;
}
