import { randomUUID } from "node:crypto";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { boundedError, OutputTail } from "./output";
import { shellEnvironment } from "./shell-context";
import type {
	BackgroundCommandCompletion,
	BackgroundCommandCompletionBinding,
	BackgroundCommandFlush,
	BackgroundCommandHandle,
	BackgroundCommandSnapshot,
	BackgroundCommandStart,
	BackgroundCommands,
	BackgroundCommandsBinding,
	BackgroundCommandsOptions,
	BackgroundCommandTerminalSnapshot,
} from "./types";

interface CommandRecord {
	handle: BackgroundCommandHandle;
	output: OutputTail;
	settlement: Promise<void>;
	pending: boolean;
	terminal: BackgroundCommandTerminalSnapshot | undefined;
}

type Settlement = Pick<BackgroundCommandTerminalSnapshot, "status"> &
	Partial<Pick<BackgroundCommandTerminalSnapshot, "exitCode" | "errorMessage">>;

function validateStart(input: BackgroundCommandStart): void {
	if (!input.command.trim() || Buffer.byteLength(input.command, "utf8") > 64 * 1024) {
		throw new Error("Command must be nonempty and at most 64 KiB");
	}
	if (input.name !== undefined && [...input.name].length > 200) {
		throw new Error("Display name must be at most 200 characters");
	}
	if (
		input.timeout !== undefined &&
		(!Number.isFinite(input.timeout) || input.timeout <= 0 || input.timeout > 2147483.647)
	) {
		throw new Error("Timeout must be finite, positive seconds, at most 2147483.647");
	}
}

export function createBackgroundCommands(
	binding: BackgroundCommandsBinding,
	options: BackgroundCommandsOptions = {},
): BackgroundCommands {
	const sessionId = binding.sessionId;
	if (!sessionId) throw new Error("A session identity is required");
	const records = new Map<string, CommandRecord>();
	const finished: string[] = [];
	const listeners = new Set<() => void>();
	let completionBinding: BackgroundCommandCompletionBinding | undefined;
	let disposed = false;
	let disposal: Promise<void> | undefined;
	let flushing = false;

	const changed = () => {
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch {}
		}
	};
	const gateOpen = (target: BackgroundCommandCompletionBinding, flush: BackgroundCommandFlush) => {
		try {
			return (
				binding.canDeliverCompletion?.() !== false && target.canDeliverCompletion?.(flush) !== false
			);
		} catch {
			return false;
		}
	};
	const flushCompletions = (flush: BackgroundCommandFlush = {}) => {
		const target = completionBinding;
		if (flushing || disposed || !target) return;
		flushing = true;
		try {
			if (!gateOpen(target, flush)) return;
			const batch = [...records.values()].flatMap((record) => {
				const output = record.pending ? record.handle.output : undefined;
				return output && record.terminal
					? [{ record, completion: { snapshot: { ...record.terminal }, output } }]
					: [];
			});
			if (batch.length === 0) return;
			for (const { record } of batch) record.pending = false;
			let accepted = new Set<BackgroundCommandCompletion>();
			try {
				accepted = new Set(
					target.deliver(
						batch.map(({ completion }) => completion),
						flush,
					),
				);
			} catch {}
			for (const { record, completion } of batch) {
				if (!accepted.has(completion) && !disposed) record.pending = true;
			}
		} finally {
			flushing = false;
		}
	};

	return {
		sessionId,
		start(input) {
			if (disposed) throw new Error("Background commands service is disposed");
			validateStart(input);
			if (
				[...records.values()].filter((r) => r.handle.snapshot.finishedAt === undefined).length >= 8
			) {
				throw new Error("At most 8 background commands may be active in this session");
			}
			const id = randomUUID();
			const controller = new AbortController();
			const command = input.command;
			const timeout = input.timeout;
			let snapshot: BackgroundCommandSnapshot = {
				id,
				sessionId,
				command,
				name: input.name ?? [...command].slice(0, 200).join(""),
				status: "running",
				startedAt: Date.now(),
			};
			const output = new OutputTail();
			const handle: BackgroundCommandHandle = {
				id,
				get snapshot() {
					return { ...snapshot };
				},
				get output() {
					return output.snapshot;
				},
				stop() {
					if (snapshot.status === "running") {
						snapshot = { ...snapshot, status: "stopping" };
						controller.abort();
						changed();
					}
					return handle.snapshot;
				},
				claimCompletion() {
					if (snapshot.finishedAt !== undefined) record.pending = false;
				},
			};
			let settle = () => {};
			const settlement = new Promise<void>((resolve) => {
				settle = resolve;
			});
			const record: CommandRecord = {
				handle,
				output,
				pending: false,
				settlement,
				terminal: undefined,
			};
			records.set(id, record);
			changed();
			const execute = async () => {
				let settled: Settlement;
				try {
					controller.signal.throwIfAborted();
					const context = binding.getContext();
					controller.signal.throwIfAborted();
					const operations = (options.createOperations ?? createLocalBashOperations)(
						context.shellPath ? { shellPath: context.shellPath } : {},
					);
					const resolvedCommand = context.commandPrefix
						? `${context.commandPrefix}\n${command}`
						: command;
					const { exitCode } = await operations.exec(resolvedCommand, context.cwd, {
						env: shellEnvironment(sessionId, context),
						onData: (data) => output.append(data),
						signal: controller.signal,
						...(timeout === undefined ? {} : { timeout }),
					});
					if (controller.signal.aborted) settled = { status: "stopped", exitCode };
					else if (exitCode === 0) settled = { status: "completed", exitCode };
					else
						settled = {
							status: "error",
							exitCode,
							errorMessage:
								exitCode === null
									? "Command ended without an exit code"
									: `Command exited with code ${exitCode}`,
						};
				} catch (error) {
					settled = controller.signal.aborted
						? { status: "stopped" }
						: { status: "error", errorMessage: boundedError(error) };
				}
				output.finish();
				const terminal = { ...snapshot, ...settled, finishedAt: Date.now() };
				snapshot = terminal;
				record.terminal = terminal;
				record.pending = !disposed;
				finished.push(id);
				while (finished.length > 20) {
					const evicted = finished.shift();
					if (evicted === undefined) break;
					records.get(evicted)?.output.clear();
					records.delete(evicted);
				}
				changed();
				flushCompletions();
				settle();
			};
			void execute();
			return handle;
		},
		list: () => [...records.values()].map((record) => record.handle.snapshot),
		find: (id) => records.get(id)?.handle,
		onChange(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		bindCompletion(target) {
			const current: BackgroundCommandCompletionBinding = {
				deliver: (batch, flush) => target.deliver(batch, flush),
				canDeliverCompletion: (flush) => target.canDeliverCompletion?.(flush) !== false,
			};
			completionBinding = disposed ? undefined : current;
			flushCompletions();
			return () => {
				if (completionBinding === current) completionBinding = undefined;
			};
		},
		flushCompletions,
		dispose(disposeOptions) {
			if (disposal) return disposal;
			const timeoutMs = disposeOptions?.timeoutMs ?? 5000;
			if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647)
				throw new Error("Invalid disposal timeout");
			disposed = true;
			completionBinding = undefined;
			let resolveDisposal = () => {};
			disposal = new Promise<void>((resolve) => {
				resolveDisposal = resolve;
			});
			const captured = [...records.values()];
			for (const record of captured) record.handle.stop();
			const timer = setTimeout(resolveDisposal, timeoutMs);
			void Promise.all(captured.map((record) => record.settlement)).then(() => {
				clearTimeout(timer);
				resolveDisposal();
			});
			return disposal;
		},
	};
}
