export type Schedule = (run: () => void, ms: number) => () => void;

export const timerSchedule: Schedule = (run, ms) => {
	const timer = setTimeout(run, ms);
	return () => clearTimeout(timer);
};

export function createAutosave({
	delayMs,
	schedule,
	fire,
	changed,
}: {
	delayMs: number;
	schedule: Schedule;
	fire(key: string): void;
	changed(key: string): void;
}) {
	const armed = new Map<string, () => void>();

	const disarm = (key: string) => {
		const cancel = armed.get(key);
		if (!cancel) return false;
		cancel();
		armed.delete(key);
		return true;
	};

	const run = (key: string) => {
		armed.delete(key);
		fire(key);
		changed(key);
	};

	const flush = (key: string) => {
		if (disarm(key)) run(key);
	};

	return {
		isArmed: (key: string) => armed.has(key),
		arm(key: string, { notify = true }: { notify?: boolean } = {}) {
			const wasArmed = disarm(key);
			armed.set(
				key,
				schedule(() => run(key), delayMs),
			);
			if (!wasArmed && notify) changed(key);
		},
		cancel(key: string) {
			if (disarm(key)) changed(key);
		},
		flush,
		flushAll() {
			for (const key of [...armed.keys()]) flush(key);
		},
		cancelAll() {
			for (const key of [...armed.keys()]) {
				disarm(key);
				changed(key);
			}
		},
	};
}
