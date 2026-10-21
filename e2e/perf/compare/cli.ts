import { E2E_ROOT_DIR, processRunnerInterruption, signalExitCode } from "../../processRunner";
import { HELP, parseArgs } from "./args";
import { cleanAll, cleanSha, resolveSha } from "./checkout";
import { prepareRefs, runCompare } from "./compare";
import { runOnHosts } from "./remote";

async function main(argv: readonly string[]) {
	const command = parseArgs(argv);
	if (command.kind === "help") {
		console.log(HELP);
		return 0;
	}
	if (command.kind === "clean") {
		const removed =
			"all" in command.target
				? cleanAll()
				: await cleanSha(resolveSha(E2E_ROOT_DIR, command.target.ref));
		console.log(`perf:compare: removed ${removed}`);
		return 0;
	}
	if (command.kind === "prepare") {
		const prepared = await prepareRefs({
			toolRoot: E2E_ROOT_DIR,
			refs: command.refs,
			options: command.options,
		});
		for (const side of prepared) console.log(`${side.ref} ${side.sha} ${side.appRoot}`);
		const failures = prepared.flatMap((side) =>
			[...side.failed].map(([key, reason]) => `${side.ref}: ${key} build failed: ${reason}`),
		);
		for (const failure of failures) console.error(`perf:compare: ${failure}`);
		return failures.length > 0 ? 1 : 0;
	}
	if (command.hosts.length > 1 || command.hosts[0] !== "local") {
		const run = await runOnHosts({
			toolRoot: E2E_ROOT_DIR,
			baseRef: command.base,
			headRef: command.head,
			hosts: command.hosts,
			options: command.options,
			forward: command.forward,
		});
		process.stdout.write(run.markdown);
		console.error(`perf:compare: wrote ${run.markdownPath}`);
		for (const failure of run.failures) console.error(`perf:compare: ${failure}`);
		return run.failures.length > 0 ? 1 : 0;
	}
	const run = await runCompare({
		toolRoot: E2E_ROOT_DIR,
		baseRef: command.base,
		headRef: command.head,
		options: command.options,
	});
	process.stdout.write(run.markdown);
	console.error(`perf:compare: wrote ${run.markdownPath}`);
	if (run.result.suites.some((suite) => suite.metrics.length > 0)) return 0;
	console.error("perf:compare: no suite produced metrics");
	return 1;
}

try {
	process.exitCode = await main(process.argv.slice(2));
} catch (error) {
	const signal = processRunnerInterruption();
	if (signal) process.exitCode = signalExitCode(signal);
	else {
		console.error(`perf:compare: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
