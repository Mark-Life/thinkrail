export interface CommonFlags {
	port?: number;
	open: boolean;
	json?: string;
	refresh: boolean;
	cwd?: string;
}

export type Command =
	| { mode: "map" }
	| { mode: "diff"; base?: string; head?: string; threeDot: boolean }
	| { mode: "pr"; number: number; repo?: string }
	| { mode: "help" };

interface ParsedArgs {
	command: Command;
	flags: CommonFlags;
}

export class UsageError extends Error {}

export const USAGE = `repo-map: see a TypeScript codebase as a graph

Usage:
  repo-map                          map the working tree of the repo holding cwd
  repo-map diff [base] [head]       compare two graphs (also base..head and base...head)
                                    base defaults to merge-base of HEAD and main
                                    head defaults to the working tree
  repo-map pr <number> [--repo o/n] compare a GitHub PR against its merge-base

Flags:
  --port <n>     port to serve on, default 4577, falls forward if taken
  --no-open      do not open the browser
  --json <path>  write the graph or diff JSON and exit
  --refresh      ignore the cache
  --cwd <dir>    use this directory instead of cwd
  --repo <o/n>   GitHub repo for pr mode, default is the one behind origin
  -h, --help     show this help
`;

function parsePort(value: string | undefined) {
	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new UsageError(`Invalid --port value: ${value ?? "(missing)"}`);
	}
	return port;
}

function requireValue(flag: string, value: string | undefined) {
	if (value === undefined || value.startsWith("--")) {
		throw new UsageError(`${flag} needs a value`);
	}
	return value;
}

function parseDiffRefs(refs: readonly string[]): Command {
	if (refs.length > 2) throw new UsageError("diff takes at most two refs");
	const [first, second] = refs;
	if (first && !second && first.includes("..")) {
		const threeDot = first.includes("...");
		const [base, head] = first.split(threeDot ? "..." : "..");
		return {
			mode: "diff",
			threeDot,
			...(base ? { base } : {}),
			...(head ? { head } : {}),
		};
	}
	return {
		mode: "diff",
		threeDot: false,
		...(first ? { base: first } : {}),
		...(second ? { head: second } : {}),
	};
}

function parsePr(positional: readonly string[], repo: string | undefined): Command {
	const [value, extra] = positional;
	const number = Number(value);
	if (!value || extra || !Number.isInteger(number) || number <= 0) {
		throw new UsageError("pr needs one PR number");
	}
	return { mode: "pr", number, ...(repo ? { repo } : {}) };
}

export function parseArgs(argv: readonly string[]) {
	const flags: CommonFlags = { open: true, refresh: false };
	const positional: string[] = [];
	let repo: string | undefined;
	let help = false;
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === undefined) continue;
		if (argument === "-h" || argument === "--help") help = true;
		else if (argument === "--no-open") flags.open = false;
		else if (argument === "--refresh") flags.refresh = true;
		else if (argument === "--port") flags.port = parsePort(argv[++index]);
		else if (argument === "--json") flags.json = requireValue(argument, argv[++index]);
		else if (argument === "--cwd") flags.cwd = requireValue(argument, argv[++index]);
		else if (argument === "--repo") repo = requireValue(argument, argv[++index]);
		else if (argument.startsWith("--")) throw new UsageError(`Unknown flag: ${argument}`);
		else positional.push(argument);
	}
	if (help) {
		const parsed: ParsedArgs = { command: { mode: "help" }, flags };
		return parsed;
	}
	const [mode, ...rest] = positional;
	if (repo && mode !== "pr") throw new UsageError("--repo only applies to pr");
	let command: Command;
	if (mode === undefined) command = { mode: "map" };
	else if (mode === "diff") command = parseDiffRefs(rest);
	else if (mode === "pr") command = parsePr(rest, repo);
	else throw new UsageError(`Unknown command: ${mode}`);
	const parsed: ParsedArgs = { command, flags };
	return parsed;
}
