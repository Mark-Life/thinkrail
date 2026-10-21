import { expect, test } from "bun:test";
import { parseArgs } from "./args";

test("--host is repeatable and defaults to local", () => {
	const local = parseArgs(["a", "b"]);
	expect(local.kind === "run" && local.hosts).toEqual(["local"]);
	const remote = parseArgs(["a", "b", "--host", "box-a", "--host", "box-b", "--suite", "bundle"]);
	expect(remote.kind === "run" && remote.hosts).toEqual(["box-a", "box-b"]);
	expect(remote.kind === "run" && remote.options.suites).toEqual(["bundle"]);
});

test("--host rejects malformed hosts and non-run commands", () => {
	expect(() => parseArgs(["a", "b", "--host", "-oProxyCommand=x"])).toThrow("--host needs");
	expect(() => parseArgs(["prepare", "a", "--host", "box-a"])).toThrow("compare runs only");
});
