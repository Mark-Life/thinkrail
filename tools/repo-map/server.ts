import { createApiHandlers } from "./api";
import type { Session } from "./session";
import indexPage from "./ui/index.html";

const DEFAULT_PORT = 4577;
const MAX_PORT_ATTEMPTS = 50;
const HOSTNAME = "127.0.0.1";

function isAddressInUse(error: unknown) {
	return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}

export function startServer(input: { session: Session; port?: number }) {
	const api = createApiHandlers(input.session);
	const first = input.port ?? DEFAULT_PORT;
	for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
		try {
			return Bun.serve({
				hostname: HOSTNAME,
				port: first === 0 ? 0 : first + attempt,
				development: false,
				routes: {
					"/": indexPage,
					"/api/session": { GET: api.session },
					"/api/graph": { GET: api.graph },
					"/api/diff": { GET: api.diff },
					"/api/source": { GET: api.source },
				},
				fetch: () => new Response("Not found", { status: 404 }),
			});
		} catch (error) {
			if (!isAddressInUse(error)) throw error;
		}
	}
	throw new Error(`No free port from ${first} to ${first + MAX_PORT_ATTEMPTS - 1}`);
}

export function openBrowser(url: string) {
	const opener = process.platform === "darwin" ? "open" : "xdg-open";
	Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" });
}
