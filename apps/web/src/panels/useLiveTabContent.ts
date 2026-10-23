import { useCallback, useEffect, useRef } from "react";
import { fsChangedPaths, selectWorkspaceTick, useAppStore } from "../store";
import { createLatestOperation, type LatestOperation } from "./latestOperation";

export function useLiveTabContent<T>(
	tab: { workspaceId: string; path: string; loadedTick?: number },
	ops: {
		read: () => Promise<T>;
		applyFresh: (fresh: T, tick: number) => void;
		keepCurrent: (tick: number) => void;
		readFailed?: () => void;
	},
	reloadKey?: string,
	loadedKey?: string,
) {
	const change = useAppStore((s) => s.fsChangesByWorkspace[tab.workspaceId]);
	const opsRef = useRef(ops);
	const tabRef = useRef(tab);
	opsRef.current = ops;
	tabRef.current = tab;
	const sequencerRef = useRef<ReadSequencer | null>(null);
	const mountedRef = useRef(true);
	sequencerRef.current ??= createReadSequencer();
	const sequencer = sequencerRef.current;

	useEffect(() => {
		if (!change) return;
		const loaded = tab.loadedTick ?? 0;
		if (change.tick <= loaded) return;
		const paths = fsChangedPaths(change);
		if (change.tick === loaded + 1 && paths !== null && !paths.includes(tab.path)) {
			opsRef.current.keepCurrent(change.tick);
			return;
		}
		let cancelled = false;
		const isCurrent = sequencer.begin();
		opsRef.current
			.read()
			.then((fresh) => {
				if (!cancelled && isCurrent()) opsRef.current.applyFresh(fresh, change.tick);
			})
			.catch(() => {
				if (cancelled || !isCurrent()) return;
				opsRef.current.keepCurrent(change.tick);
				opsRef.current.readFailed?.();
			});
		return () => {
			cancelled = true;
		};
	}, [change, tab.path, tab.loadedTick, sequencer]);

	const lastKey = useRef(loadedKey ?? reloadKey);
	useEffect(() => {
		if (reloadKey === undefined || reloadKey === lastKey.current) return;
		lastKey.current = reloadKey;
		let cancelled = false;
		const isCurrent = sequencer.begin();
		opsRef.current
			.read()
			.then((fresh) => {
				if (!cancelled && isCurrent()) opsRef.current.applyFresh(fresh, tab.loadedTick ?? 0);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [reloadKey, tab.loadedTick, sequencer]);

	const reload = useCallback(() => {
		if (!mountedRef.current) return;
		const current = tabRef.current;
		const isCurrent = sequencer.begin();
		void opsRef.current
			.read()
			.then((fresh) => {
				if (mountedRef.current && isCurrent()) {
					opsRef.current.applyFresh(
						fresh,
						selectWorkspaceTick(useAppStore.getState(), current.workspaceId),
					);
				}
			})
			.catch(() => {});
	}, [sequencer]);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			sequencer.begin();
		};
	}, [sequencer]);

	return { reload };
}

export type ReadSequencer = LatestOperation;
export const createReadSequencer = createLatestOperation;
