import { CodedError } from "@thinkrail/shared/codedError";
import type { DesktopHostOptions, desktopHostStarter } from "../runtimeEntry";

type StartedHost = Awaited<ReturnType<ReturnType<typeof desktopHostStarter>>>;
type Call = (...args: unknown[]) => unknown;
type ServerCall = keyof StartedHost["server"];

function call(owner: unknown, name: string): Call | null {
	if (typeof owner !== "object" || owner === null) return null;
	const member: unknown = Reflect.get(owner, name);
	if (typeof member !== "function") return null;
	return (...args) => Reflect.apply(member, owner, args);
}

function runtimeInvalid(message: string) {
	return new CodedError("HOST_ERROR", `server runtime: ${message}`);
}

/**
 * Starts the host from the server runtime module, which loads from a computed path and reaches the desktop
 * untyped. The desktop calls its functions with the arguments the server's types name and checks what they return.
 */
export async function startServerRuntime(runtime: unknown, options: DesktopHostOptions) {
	const start = call(runtime, "startDesktopHost");
	if (!start) throw runtimeInvalid("it does not export startDesktopHost");
	const host: unknown = await start(options);
	const record = typeof host === "object" && host !== null ? host : {};
	const port: unknown = Reflect.get(record, "port" satisfies keyof StartedHost);
	const server: unknown = Reflect.get(record, "server" satisfies keyof StartedHost);
	const reportError = call(host, "reportError" satisfies keyof StartedHost);
	const shutdown = call(server, "shutdown" satisfies ServerCall);
	const startAttributionClaim = call(server, "startAttributionClaim" satisfies ServerCall);
	if (typeof port !== "number" || !reportError || !shutdown || !startAttributionClaim)
		throw runtimeInvalid("the started host lacks its port, error reporter or server controls");
	return {
		port,
		reportError: (...args: Parameters<StartedHost["reportError"]>) => void reportError(...args),
		shutdown: async () => {
			await shutdown();
		},
		startAttributionClaim: () => void startAttributionClaim(),
	};
}
