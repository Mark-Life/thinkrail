export const EDIT_FLUSH_TIMEOUT_MS = 2000;

export interface FlushBeforeShutdownOptions {
	flush(): Promise<void>;
	shutdown(): Promise<void>;
	timeoutMs: number;
	reportError(error: unknown): void;
}

/** Waits for the web client to write its pending drafts, bounded, before the host stops. */
export const flushBeforeShutdown =
	({ flush, shutdown, timeoutMs, reportError }: FlushBeforeShutdownOptions) =>
	async () => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, timeoutMs);
		});
		try {
			await Promise.race([Promise.resolve().then(flush), timeout]);
		} catch (error) {
			reportError(error);
		} finally {
			clearTimeout(timer);
		}
		await shutdown();
	};

/** Whether a native event can carry a `{ allow }` veto, as `before-quit` and `will-close` do. */
export const isVetoableEvent = (
	event: unknown,
): event is { response: { allow: boolean } | undefined } =>
	typeof event === "object" && event !== null && "response" in event;
