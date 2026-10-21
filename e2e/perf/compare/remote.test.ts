import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { forwardArgs, isLocalHost, normalizeHost, requiredBrowsers, shellQuote } from "./remote";
import type { CompareOptions } from "./types";

const OPTIONS: CompareOptions = {
	suites: ["bundle", "startup"],
	scenarios: null,
	rounds: null,
	startup: ["cli", "server"],
	minRuns: 10,
	maxMinutes: 3,
	threshold: 0,
	cpu: 1,
	browser: "chromium",
	strictProtocol: false,
	out: "/tmp/out",
	rebuild: false,
	jsonOnly: false,
};

test("shellQuote survives a real shell", () => {
	const values = ["plain", "it's", "a b", "$HOME", "`id`", "x'\"y"];
	const script = `printf '%s\\n' ${values.map(shellQuote).join(" ")}`;
	expect(execFileSync("sh", ["-c", script], { encoding: "utf8" }).trimEnd().split("\n")).toEqual(
		values,
	);
});

test("normalizeHost drops domains but keeps IPs", () => {
	expect(normalizeHost("Andreys-Mac-Studio.local")).toBe("andreys-mac-studio");
	expect(normalizeHost("rs8000.tail1234.ts.net.")).toBe("rs8000");
	expect(normalizeHost("100.75.236.52")).toBe("100.75.236.52");
});

test("isLocalHost matches the alias, its ssh hostname, or local", () => {
	const localName = "Andreys-Mac-Studio.local";
	expect(isLocalHost({ host: "local", localName, sshHostname: "local" })).toBe(true);
	expect(isLocalHost({ host: "studio", localName, sshHostname: "andreys-mac-studio" })).toBe(true);
	expect(isLocalHost({ host: "rs8000", localName, sshHostname: "rs8000" })).toBe(false);
	expect(isLocalHost({ host: "rs8000", localName: "rs8000", sshHostname: "rs8000" })).toBe(true);
});

test("forwardArgs carries every measurement option and nothing host-specific", () => {
	const args = forwardArgs({
		...OPTIONS,
		scenarios: ["chat-streaming"],
		rounds: 2,
		strictProtocol: true,
		rebuild: true,
		jsonOnly: true,
	});
	expect(args).toEqual([
		"--suite",
		"bundle,startup",
		"--scenario",
		"chat-streaming",
		"--rounds",
		"2",
		"--startup",
		"cli,server",
		"--min-runs",
		"10",
		"--max-minutes",
		"3",
		"--threshold",
		"0",
		"--cpu",
		"1",
		"--browser",
		"chromium",
		"--strict-protocol",
		"--rebuild",
	]);
	expect(forwardArgs(OPTIONS)).not.toContain("--rounds");
});

test("requiredBrowsers follows the browser suites", () => {
	expect(requiredBrowsers(OPTIONS)).toEqual([]);
	expect(requiredBrowsers({ ...OPTIONS, suites: ["renders"] })).toEqual(["chromium"]);
	expect(
		requiredBrowsers({ ...OPTIONS, suites: ["renders", "waterfall"], browser: "webkit" }),
	).toEqual(["chromium", "webkit"]);
});
