import { expect, test } from "bun:test";
import { parseArgs } from "./args";

test("--host is repeatable and defaults to local", () => {
	const local = parseArgs(["a", "b"]);
	expect(local.kind === "run" && local.hosts).toEqual(["local"]);
	const remote = parseArgs(["a", "b", "--host", "rs8000", "--host", "studio", "--suite", "bundle"]);
	expect(remote.kind === "run" && remote.hosts).toEqual(["rs8000", "studio"]);
	expect(remote.kind === "run" && remote.options.suites).toEqual(["bundle"]);
});

test("--host rejects unknown hosts and non-run commands", () => {
	expect(() => parseArgs(["a", "b", "--host", "elsewhere"])).toThrow("--host needs one of");
	expect(() => parseArgs(["prepare", "a", "--host", "rs8000"])).toThrow("compare runs only");
});
