export interface BackfillQueueOptions<Key extends string> {
	readonly concurrency: number;
	readonly run: (key: Key) => Promise<unknown>;
	readonly isWanted?: (key: Key) => boolean;
}

export interface BackfillQueue<Key extends string> {
	readonly schedule: (keys: readonly Key[]) => void;
	readonly clearPending: () => void;
}

export function createBackfillQueue<Key extends string>(
	options: BackfillQueueOptions<Key>,
): BackfillQueue<Key> {
	const pending: Key[] = [];
	const inFlight = new Set<Key>();
	const rerun = new Set<Key>();
	const wanted = (key: Key) => options.isWanted?.(key) ?? true;

	const pump = (): void => {
		while (inFlight.size < options.concurrency) {
			const key = pending.shift();
			if (key === undefined) return;
			if (!wanted(key)) continue;
			inFlight.add(key);
			void options
				.run(key)
				.catch(() => {})
				.finally(() => {
					inFlight.delete(key);
					if (rerun.delete(key) && !pending.includes(key)) pending.push(key);
					pump();
				});
		}
	};

	return {
		schedule(keys) {
			pending.length = 0;
			rerun.clear();
			for (const key of keys) {
				if (inFlight.has(key)) rerun.add(key);
				else if (!pending.includes(key) && wanted(key)) pending.push(key);
			}
			pump();
		},
		clearPending() {
			pending.length = 0;
			rerun.clear();
		},
	};
}
