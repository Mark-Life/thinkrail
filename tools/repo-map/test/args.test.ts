import { describe, expect, test } from "bun:test";
import { parseArgs, UsageError } from "../args";
import { parseStatus } from "../git";
import { repoFromRemoteUrl } from "../session";

describe("parseArgs", () => {
	test("defaults to map mode", () => {
		expect(parseArgs([])).toEqual({
			command: { mode: "map" },
			flags: { open: true, refresh: false },
		});
	});

	test("parses diff refs in every form", () => {
		expect(parseArgs(["diff"]).command).toEqual({ mode: "diff", threeDot: false });
		expect(parseArgs(["diff", "main"]).command).toEqual({
			mode: "diff",
			threeDot: false,
			base: "main",
		});
		expect(parseArgs(["diff", "a", "b"]).command).toEqual({
			mode: "diff",
			threeDot: false,
			base: "a",
			head: "b",
		});
		expect(parseArgs(["diff", "a..b"]).command).toEqual({
			mode: "diff",
			threeDot: false,
			base: "a",
			head: "b",
		});
		expect(parseArgs(["diff", "a...b"]).command).toEqual({
			mode: "diff",
			threeDot: true,
			base: "a",
			head: "b",
		});
		expect(() => parseArgs(["diff", "a", "b", "c"])).toThrow(UsageError);
	});

	test("parses pr mode", () => {
		expect(parseArgs(["pr", "12"]).command).toEqual({ mode: "pr", number: 12 });
		expect(parseArgs(["pr", "12", "--repo", "o/n"]).command).toEqual({
			mode: "pr",
			number: 12,
			repo: "o/n",
		});
		expect(() => parseArgs(["pr"])).toThrow(UsageError);
		expect(() => parseArgs(["pr", "abc"])).toThrow(UsageError);
		expect(() => parseArgs(["--repo", "o/n"])).toThrow(UsageError);
	});

	test("parses flags", () => {
		expect(
			parseArgs([
				"--port",
				"5000",
				"--no-open",
				"--json",
				"/tmp/a.json",
				"--refresh",
				"--cwd",
				"/x",
			]).flags,
		).toEqual({ port: 5000, open: false, json: "/tmp/a.json", refresh: true, cwd: "/x" });
		expect(() => parseArgs(["--port", "nope"])).toThrow(UsageError);
		expect(() => parseArgs(["--json"])).toThrow(UsageError);
		expect(() => parseArgs(["--wat"])).toThrow(UsageError);
		expect(() => parseArgs(["wat"])).toThrow(UsageError);
		expect(parseArgs(["--help"]).command).toEqual({ mode: "help" });
	});
});

describe("repoFromRemoteUrl", () => {
	test("reads ssh, https and path remotes", () => {
		expect(repoFromRemoteUrl("git@github.com:acme/widget.git")).toBe("acme/widget");
		expect(repoFromRemoteUrl("https://github.com/acme/widget")).toBe("acme/widget");
		expect(repoFromRemoteUrl("/tmp/x/acme/widget.git\n")).toBe("acme/widget");
	});
});

describe("parseStatus", () => {
	test("skips the origin path of a rename", () => {
		expect(parseStatus(" M a.ts\0R  new.ts\0old.ts\0?? c.ts\0")).toEqual([
			"a.ts",
			"new.ts",
			"c.ts",
		]);
	});
});
