import { useEffect } from "react";

const IDLE_WARMUP_FALLBACK_MS = 1_000;

export function useIdleWarmup(enabled: boolean, warm: () => void): void {
	useEffect(() => {
		if (!enabled) return;
		if (typeof requestIdleCallback === "function") {
			const handle = requestIdleCallback(warm);
			return () => cancelIdleCallback(handle);
		}
		const handle = setTimeout(warm, IDLE_WARMUP_FALLBACK_MS);
		return () => clearTimeout(handle);
	}, [enabled, warm]);
}
