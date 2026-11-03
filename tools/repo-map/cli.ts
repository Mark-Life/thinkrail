#!/usr/bin/env bun
import { parseArgs, USAGE, UsageError } from "./args";
import type { GraphRef, IndexStats } from "./core/types";
import { openBrowser, startServer } from "./server";
import { buildSession, type Session } from "./session";

function refLabel(ref: GraphRef) {
	const sha = ref.sha.slice(0, 12);
	return ref.kind === "commit" ? sha : `${sha} + ${ref.dirtyFiles.length} dirty`;
}

function percent(part: number, whole: number) {
	return whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`;
}

function printStats(label: string, stats: IndexStats) {
	console.log(
		[
			`${label}: ${stats.files} files, indexed in ${(stats.durationMs / 1000).toFixed(1)}s`,
			`  call sites: ${stats.callSites}: in repo ${percent(stats.resolvedInRepo, stats.callSites)}, external ${percent(stats.resolvedExternal, stats.callSites)}, callback or local ${percent(stats.dynamicCalls, stats.callSites)}, unresolved ${percent(stats.unresolved, stats.callSites)}`,
			`  wire methods: ${stats.wireMethods}: with handler ${stats.wireMethodsWithHandler}, with caller ${stats.wireMethodsWithCaller}, dynamic request sites ${stats.wireDynamicRequests}, requests with no handler ${stats.wireUnhandledRequests}`,
			`  wire channels: ${stats.wireChannels}: linked ${stats.wireChannelsLinked}`,
			`  tools: ${stats.tools}: linked to a renderer ${stats.toolsLinked}, renderer names ${stats.toolRenderers}`,
		].join("\n"),
	);
}

function printSession(session: Session) {
	if (session.base) printStats(`base ${refLabel(session.base.ref)}`, session.base.stats);
	printStats(`head ${refLabel(session.head.ref)}`, session.head.stats);
	const { diff } = session;
	if (diff) {
		const changes = diff.groups.reduce((total, group) => total + group.symbolChanges.length, 0);
		console.log(
			`diff: ${diff.groups.length} groups, ${changes} symbol changes, ${diff.movedOnly.length} moved, ${diff.contracts.length} contract changes, ${diff.changedFiles.length} code files, ${diff.formatOnlyFiles.length} format-only, ${diff.nonCodeFiles.length} non-code`,
		);
	}
}

async function main() {
	const { command, flags } = parseArgs(process.argv.slice(2));
	if (command.mode === "help") {
		console.log(USAGE);
		return;
	}
	const session = buildSession({ command, flags, cwd: process.cwd() });
	printSession(session);
	if (flags.json) {
		await Bun.write(flags.json, JSON.stringify(session.diff ?? session.head));
		console.log(`wrote ${flags.json}`);
		return;
	}
	const server = startServer({
		session,
		...(flags.port !== undefined ? { port: flags.port } : {}),
	});
	const url = `http://${server.hostname}:${server.port}/`;
	console.log(`serving ${url}`);
	if (flags.open) openBrowser(url);
}

try {
	await main();
} catch (error) {
	if (error instanceof UsageError) {
		console.error(`${error.message}\n\n${USAGE}`);
		process.exit(2);
	}
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
