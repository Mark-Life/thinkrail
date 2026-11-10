import { isIP } from "node:net";

export interface RequestSourceOptions {
	bindHost: string;
	machineName: string;
	allowedHosts: readonly string[];
}

export type RequestSourceVerdict =
	| { ok: true }
	| { ok: false; status: 400 | 403; rule: "host" | "origin"; message: string };

const HOST_HEADER = /^[A-Za-z0-9._\-:[\]]{1,300}$/;
const ALLOWED_HOST = /^\.?[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;
const MAPPED_LOOPBACK = /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/;
const BAD_HOST: RequestSourceVerdict = {
	ok: false,
	status: 400,
	rule: "host",
	message: "bad Host header",
};
const NOT_A_SITE: RequestSourceVerdict = {
	ok: false,
	status: 403,
	rule: "origin",
	message:
		"ThinkRail refused a request from a page that is not an http(s) site (a sandboxed frame, a file or an extension).",
};

function withoutTrailingDot(name: string): string {
	return name.endsWith(".") ? name.slice(0, -1) : name;
}

function authorityOf(host: string, protocol: string): URL | null {
	return HOST_HEADER.test(host) ? URL.parse(`${protocol}//${host}`) : null;
}

function nameOf(authority: URL): string {
	return withoutTrailingDot(authority.hostname.replace(/^\[|\]$/g, ""));
}

function isLoopbackBind(bindHost: string): boolean {
	const authority = authorityOf(isIP(bindHost) === 6 ? `[${bindHost}]` : bindHost, "http:");
	if (authority === null) return true;
	const name = nameOf(authority);
	return (
		name === "localhost" ||
		name.endsWith(".localhost") ||
		name === "::1" ||
		MAPPED_LOOPBACK.test(name) ||
		(isIP(name) === 4 && name.startsWith("127."))
	);
}

function allowedHost(value: string): string {
	const entry = withoutTrailingDot(value.trim().toLowerCase());
	if (!ALLOWED_HOST.test(entry)) {
		throw new Error(
			`Invalid allowed host: ${value} (from --allowed-host or THINKRAIL_ALLOWED_HOSTS; use a host name without scheme, port or path, a leading dot admits subdomains)`,
		);
	}
	return entry;
}

export function parseAllowedHosts(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item !== "");
}

export function createRefusalLog(
	limit: number,
	windowMs: number,
	now: () => number = Date.now,
): (message: string) => boolean {
	const logged = new Set<string>();
	let windowStart = 0;
	return (message) => {
		const at = now();
		if (at - windowStart >= windowMs) {
			logged.clear();
			windowStart = at;
		}
		if (logged.size >= limit || logged.has(message)) return false;
		logged.add(message);
		return true;
	};
}

export function createRequestSourceCheck(
	options: RequestSourceOptions,
): (host: string | null, origin: string | null) => RequestSourceVerdict {
	const entries = options.allowedHosts.map(allowedHost);
	const names = new Set(entries.filter((entry) => !entry.startsWith(".")));
	const suffixes = [".localhost", ...entries.filter((entry) => entry.startsWith("."))];
	const wide = !isLoopbackBind(options.bindHost);
	if (wide) {
		suffixes.push(".local", ".ts.net");
		names.add(withoutTrailingDot(options.machineName.toLowerCase()));
		names.add(withoutTrailingDot(options.bindHost.toLowerCase()));
	}

	return (host, origin) => {
		const authority = host === null ? null : authorityOf(host, "http:");
		if (host === null || authority === null) return BAD_HOST;
		const name = nameOf(authority);
		if (name === "") return BAD_HOST;
		const admitted =
			isIP(name) !== 0 ||
			name === "localhost" ||
			names.has(name) ||
			suffixes.some((suffix) => name.endsWith(suffix)) ||
			(wide && !name.includes("."));
		if (!admitted) {
			return {
				ok: false,
				status: 403,
				rule: "host",
				message: `ThinkRail refused the host name "${name}". Start ThinkRail with --allowed-host ${name} (or THINKRAIL_ALLOWED_HOSTS) to admit it.`,
			};
		}
		if (origin === null) return { ok: true };
		const source = URL.parse(origin);
		if (source?.protocol !== "http:" && source?.protocol !== "https:") return NOT_A_SITE;
		const compared = (authorityOf(host, source.protocol) ?? authority).host;
		if (source.host === compared) return { ok: true };
		const shown = HOST_HEADER.test(source.host) ? `Origin ${source.host}` : "its Origin";
		return {
			ok: false,
			status: 403,
			rule: "origin",
			message: `ThinkRail refused a request from another site: ${shown} does not match Host ${compared}. If a reverse proxy is in front of ThinkRail, make it forward the original Host header.`,
		};
	};
}
