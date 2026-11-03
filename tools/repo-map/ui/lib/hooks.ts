import {
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import type { ThemedToken } from "shiki/core";
import type { GraphSide } from "../../core/types";
import { fetchSource } from "./api";
import { highlightLines } from "./highlight";
import {
	clampWidth,
	type HistoryPosition,
	nextHistoryPosition,
	parseStoredWidth,
	readEntryPosition,
} from "./panes";
import { parseHash, type Route } from "./route";

function subscribeHash(listener: () => void) {
	window.addEventListener("hashchange", listener);
	return () => window.removeEventListener("hashchange", listener);
}

function readHash() {
	return window.location.hash;
}

export function useRoute(fallback: Route) {
	const hash = useSyncExternalStore(subscribeHash, readHash);
	return parseHash(hash, fallback);
}

const HISTORY_LAST_KEY = "repo-map.history-last";

function readInitialHistory(): HistoryPosition {
	const position = readEntryPosition(window.history.state) ?? 0;
	const stored = parseStoredWidth({
		stored: window.sessionStorage.getItem(HISTORY_LAST_KEY),
		fallback: 0,
	});
	return { position, last: Math.max(position, stored) };
}

export function useHistoryPosition() {
	const [history, setHistory] = useState(readInitialHistory);
	useEffect(() => {
		let current = readInitialHistory();
		const save = () => {
			window.history.replaceState({ repoMapPosition: current.position }, "");
			window.sessionStorage.setItem(HISTORY_LAST_KEY, String(current.last));
			setHistory(current);
		};
		save();
		const onHashChange = () => {
			current = nextHistoryPosition({ current, entry: readEntryPosition(window.history.state) });
			save();
		};
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, []);
	return { canGoBack: history.position > 0, canGoForward: history.position < history.last };
}

export function usePaneWidth(input: {
	storageKey: string;
	initial: number;
	min: number;
	roomForOthers: number;
}) {
	const { storageKey, initial, min, roomForOthers } = input;
	const [width, setWidth] = useState(() =>
		parseStoredWidth({ stored: window.localStorage.getItem(storageKey), fallback: initial }),
	);
	const resize = useCallback(
		(next: number) => {
			const clamped = clampWidth({
				width: next,
				min,
				max: window.innerWidth - roomForOthers,
			});
			setWidth(clamped);
			window.localStorage.setItem(storageKey, String(clamped));
		},
		[storageKey, min, roomForOthers],
	);
	const reset = useCallback(() => {
		setWidth(initial);
		window.localStorage.removeItem(storageKey);
	}, [storageKey, initial]);
	return { width, resize, reset };
}

export function useElementSize<T extends HTMLElement>() {
	const ref = useRef<T>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		const update = () => {
			const rect = element.getBoundingClientRect();
			setSize({ width: rect.width, height: rect.height });
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return { ref, size };
}

export function useVirtualRows(input: {
	containerRef: RefObject<HTMLElement | null>;
	count: number;
	rowHeight: number;
	overscan?: number;
}) {
	const { containerRef, count, rowHeight } = input;
	const overscan = input.overscan ?? 12;
	const [range, setRange] = useState({ start: 0, end: 60 });
	const update = useCallback(() => {
		const element = containerRef.current;
		if (!element) return;
		const start = Math.max(0, Math.floor(element.scrollTop / rowHeight) - overscan);
		const end = Math.min(
			count,
			Math.ceil((element.scrollTop + element.clientHeight) / rowHeight) + overscan,
		);
		setRange((current) =>
			current.start === start && current.end === end ? current : { start, end },
		);
	}, [containerRef, count, rowHeight, overscan]);
	useLayoutEffect(() => {
		const element = containerRef.current;
		if (!element) return;
		update();
		element.addEventListener("scroll", update, { passive: true });
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => {
			element.removeEventListener("scroll", update);
			observer.disconnect();
		};
	}, [containerRef, update]);
	return range;
}

type SourceState =
	| { status: "loading" }
	| { status: "error"; retry: () => void }
	| { status: "ready"; text: string; lines: string[]; tokens: ThemedToken[][] };

export function useSource(input: { side: GraphSide; file: string }) {
	const { side, file } = input;
	const [state, setState] = useState<SourceState>({ status: "loading" });
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let cancelled = false;
		setState({ status: "loading" });
		void attempt;
		if (!file) {
			setState({ status: "ready", text: "", lines: [], tokens: [] });
			return;
		}
		fetchSource({ side, file })
			.then((text) => {
				if (cancelled) return;
				const lines = text.split("\n");
				setState({ status: "ready", text, lines, tokens: [] });
				return highlightLines({ code: text, file }).then((tokens) => {
					if (tokens && !cancelled) setState({ status: "ready", text, lines, tokens });
				});
			})
			.catch(() => {
				if (!cancelled) {
					setState({ status: "error", retry: () => setAttempt((value) => value + 1) });
				}
			});
		return () => {
			cancelled = true;
		};
	}, [side, file, attempt]);
	return state;
}

export function useCopy() {
	const [copied, setCopied] = useState(false);
	const copy = useCallback((text: string) => {
		void navigator.clipboard.writeText(text).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1200);
		});
	}, []);
	return { copied, copy };
}

export function isTypingTarget(target: EventTarget | null) {
	if (!(target instanceof HTMLElement)) return false;
	return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}
