import { describe, expect, test } from "bun:test";
import {
	createRefusalLog,
	createRequestSourceCheck,
	parseAllowedHosts,
	type RequestSourceOptions,
} from "./requestSource";

const MACHINE = "Dev-Mac.corp.example";
const policy = (bindHost: string, allowedHosts: readonly string[] = []) =>
	createRequestSourceCheck({ bindHost, machineName: MACHINE, allowedHosts });

const loopback = policy("localhost", ["tunnel.example.com", ".trycloudflare.com"]);
const wide = policy("0.0.0.0");
const desktop = policy("127.0.0.1");
const named = policy("devbox.corp.example");

type Check = ReturnType<typeof createRequestSourceCheck>;
type Row = [label: string, check: Check, host: string | null, origin: string | null];

const admitted: Row[] = [
	["CLI default", loopback, "localhost:24242", "http://localhost:24242"],
	["loopback IPv4", loopback, "127.0.0.1:24242", "http://127.0.0.1:24242"],
	["loopback IPv6", loopback, "[::1]:24242", "http://[::1]:24242"],
	["long IPv6 form", loopback, "[0:0:0:0:0:0:0:1]:24242", "http://[::1]:24242"],
	["decimal IPv4 form", loopback, "2130706433:24242", "http://127.0.0.1:24242"],
	["Vite dev proxy", loopback, "localhost:24269", "http://localhost:24269"],
	["desktop app", desktop, "127.0.0.1:51234", "http://127.0.0.1:51234"],
	["non-browser client", loopback, "localhost:24242", null],
	["case and trailing dot", loopback, "LocalHost.:24242", "http://localhost.:24242"],
	["localhost subdomain", loopback, "app.localhost:24242", "http://app.localhost:24242"],
	["default http port", loopback, "localhost:80", "http://localhost"],
	["admitted name behind TLS", loopback, "tunnel.example.com", "https://tunnel.example.com"],
	["admitted name, explicit 443", loopback, "tunnel.example.com:443", "https://tunnel.example.com"],
	["admitted suffix", loopback, "abc.trycloudflare.com", "https://abc.trycloudflare.com"],
	["LAN IP", wide, "192.168.1.5:24242", "http://192.168.1.5:24242"],
	["Tailscale IP", wide, "100.75.236.52:24242", "http://100.75.236.52:24242"],
	["MagicDNS short name", wide, "studio:24242", "http://studio:24242"],
	[
		"MagicDNS full name",
		wide,
		"studio.tail1234.ts.net:24242",
		"http://studio.tail1234.ts.net:24242",
	],
	["mDNS name", wide, "my-mac.local:24242", "http://my-mac.local:24242"],
	["machine name", wide, "dev-mac.corp.example:24242", "http://dev-mac.corp.example:24242"],
	["bind host name", named, "devbox.corp.example:24242", "http://devbox.corp.example:24242"],
];

const refusedOrigin: Row[] = [
	["another website", loopback, "localhost:24242", "https://evil.example"],
	["sandboxed frame", loopback, "localhost:24242", "null"],
	["empty Origin", loopback, "localhost:24242", ""],
	["another local port", loopback, "localhost:24242", "http://localhost:3000"],
	["another loopback spelling", loopback, "localhost:24242", "http://127.0.0.1:24242"],
	["browser extension", loopback, "localhost:24242", "chrome-extension://abcdef"],
	["file page", loopback, "localhost:24242", "file://"],
	["non-http scheme on the same host", loopback, "localhost:24242", "ws://localhost:24242"],
	["another website, wide bind", wide, "192.168.1.5:24242", "https://evil.example"],
];

const refusedHost: Row[] = [
	["DNS rebinding", loopback, "evil.example:24242", "http://evil.example:24242"],
	["DNS rebinding, wide bind", wide, "evil.example:24242", "http://evil.example:24242"],
	["DNS rebinding, no Origin", loopback, "evil.example:24242", null],
	["mDNS name on a loopback bind", loopback, "x.local:24242", "http://x.local:24242"],
	["tailnet name on a loopback bind", loopback, "x.ts.net:24242", "http://x.ts.net:24242"],
	["single label on a loopback bind", loopback, "studio:24242", "http://studio:24242"],
	["machine name on a loopback bind", loopback, "dev-mac.corp.example:24242", null],
	["localhost lookalike", loopback, "localhost.evil.example:24242", null],
	["localhost lookalike without a dot", loopback, "evillocalhost:24242", null],
	["tailnet lookalike", wide, "evil-ts.net:24242", null],
	["suffix lookalike", loopback, "eviltrycloudflare.com", null],
	["subdomain of an exact name", loopback, "sub.tunnel.example.com", null],
];

const malformedHost: Row[] = [
	["missing Host", loopback, null, null],
	["empty Host", loopback, "", null],
	["two Host headers", loopback, "localhost:1, evil.com", null],
	["userinfo", loopback, "localhost@evil.com", null],
	["space", loopback, "a b", null],
	["path", loopback, "localhost/x", null],
	["bad port", loopback, "localhost:99999", null],
	["overlong name", loopback, `${"a".repeat(300)}.localhost`, null],
	["root name", wide, ".", null],
];

describe("request source check", () => {
	test.each(admitted)("admits %s", (_label, check, host, origin) => {
		expect(check(host, origin)).toEqual({ ok: true });
	});

	test.each(refusedOrigin)("refuses the origin: %s", (_label, check, host, origin) => {
		expect(check(host, origin)).toMatchObject({ ok: false, status: 403, rule: "origin" });
	});

	test.each(refusedHost)("refuses the host: %s", (_label, check, host, origin) => {
		expect(check(host, origin)).toMatchObject({ ok: false, status: 403, rule: "host" });
	});

	test.each(
		malformedHost,
	)("answers 400 for a malformed Host: %s", (_label, check, host, origin) => {
		expect(check(host, origin)).toEqual({
			ok: false,
			status: 400,
			rule: "host",
			message: "bad Host header",
		});
	});

	test("a refused host is named with the option that admits it", () => {
		expect(loopback("Evil.Example.:24242", null)).toMatchObject({
			message:
				'ThinkRail refused the host name "evil.example". Start ThinkRail with --allowed-host evil.example (or THINKRAIL_ALLOWED_HOSTS) to admit it.',
		});
	});

	test("a refused origin is named beside the Host it was compared with", () => {
		expect(loopback("LocalHost:24242", "https://Evil.Example:443")).toMatchObject({
			message:
				"ThinkRail refused a request from another site: Origin evil.example does not match Host localhost:24242. If a reverse proxy is in front of ThinkRail, make it forward the original Host header.",
		});
		expect(loopback("tunnel.example.com:80", "https://tunnel.example.com")).toMatchObject({
			message: expect.stringContaining(
				"Origin tunnel.example.com does not match Host tunnel.example.com:80.",
			),
		});
		expect(loopback("tunnel.example.com:443", "http://tunnel.example.com")).toMatchObject({
			message: expect.stringContaining(
				"Origin tunnel.example.com does not match Host tunnel.example.com:443.",
			),
		});
		expect(loopback("localhost:24242", `http://${"a".repeat(301)}`)).toMatchObject({
			message: expect.stringContaining("another site: its Origin does not match Host"),
		});
		expect(loopback("localhost:24242", "null")).toMatchObject({
			message:
				"ThinkRail refused a request from a page that is not an http(s) site (a sandboxed frame, a file or an extension).",
		});
	});

	test.each([
		"localhost",
		"app.localhost",
		"127.0.0.1",
		"127.8.9.1",
		"::1",
		"0:0:0:0:0:0:0:1",
		"::ffff:127.0.0.1",
		"::ffff:7f00:1",
		"::ffff:127.8.9.1",
		"a b",
	])("a %p bind is loopback", (bindHost) => {
		expect(policy(bindHost)("x.local:1", null)).toMatchObject({ status: 403, rule: "host" });
	});

	test.each([
		"0.0.0.0",
		"::",
		"192.168.1.5",
		"128.0.0.1",
		"::ffff:128.0.0.1",
		"::7f00:1",
		"devbox",
	])("a %p bind is not loopback", (bindHost) => {
		expect(policy(bindHost)("x.local:1", null)).toEqual({ ok: true });
	});
});

describe("allowed hosts", () => {
	test("entries are trimmed, lower-cased and lose one trailing dot", () => {
		const check = policy("localhost", [" Tunnel.Example.COM. "]);
		expect(check("tunnel.example.com", null)).toEqual({ ok: true });
	});

	test.each([
		"",
		" ",
		"a b",
		"http://a.example",
		"a.example:443",
		"a..b",
		"*.a.example",
		".",
	])("an invalid entry %p throws", (entry) => {
		const options: RequestSourceOptions = {
			bindHost: "localhost",
			machineName: MACHINE,
			allowedHosts: [entry],
		};
		expect(() => createRequestSourceCheck(options)).toThrow(`Invalid allowed host: ${entry}`);
	});

	test("an invalid entry says where it came from and what form is valid", () => {
		expect(() => policy("localhost", ["https://a.example:443"])).toThrow(
			"Invalid allowed host: https://a.example:443 (from --allowed-host or THINKRAIL_ALLOWED_HOSTS; use a host name without scheme, port or path, a leading dot admits subdomains)",
		);
	});

	test("parseAllowedHosts splits on commas and drops empty items", () => {
		expect(parseAllowedHosts(undefined)).toEqual([]);
		expect(parseAllowedHosts("")).toEqual([]);
		expect(parseAllowedHosts(" a.example , ,.b.example,")).toEqual(["a.example", ".b.example"]);
	});
});

describe("refusal log", () => {
	test("a message is logged once and the count is capped", () => {
		const shouldLog = createRefusalLog(2, 1000, () => 0);
		expect(shouldLog("a")).toBe(true);
		expect(shouldLog("a")).toBe(false);
		expect(shouldLog("b")).toBe(true);
		expect(shouldLog("c")).toBe(false);
	});

	test("a full log takes new messages again once the window has passed", () => {
		let at = 5000;
		const shouldLog = createRefusalLog(2, 1000, () => at);
		expect(shouldLog("a")).toBe(true);
		expect(shouldLog("b")).toBe(true);
		at = 5999;
		expect(shouldLog("c")).toBe(false);
		at = 6000;
		expect(shouldLog("c")).toBe(true);
		expect(shouldLog("a")).toBe(true);
		expect(shouldLog("b")).toBe(false);
		at = 6999;
		expect(shouldLog("b")).toBe(false);
		at = 7000;
		expect(shouldLog("b")).toBe(true);
	});
});
