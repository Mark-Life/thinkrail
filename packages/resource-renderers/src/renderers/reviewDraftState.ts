import {
	createContext,
	useCallback,
	useContext,
	useMemo,
	useState,
	useSyncExternalStore,
} from "react";

export interface ReviewDraftPersistence {
	rendererId: string;
	read: (key: string) => unknown;
	subscribe: (onChange: () => void) => () => void;
	update: (key: string, change: (current: unknown) => unknown) => void;
}

export const ReviewDraftContext = createContext<ReviewDraftPersistence | null>(null);

/**
 * One draft type. The store holds an opaque token per value, and only the kind that made the token reads
 * the value back, so a slot never hands out a value another type wrote.
 */
export interface ReviewDraftKind<T> {
	wrap(value: T): object;
	unwrap(stored: unknown): T | undefined;
}

export function reviewDraftKind<T>(): ReviewDraftKind<T> {
	const values = new WeakMap<object, T>();
	return {
		wrap: (value) => {
			const token = Object.freeze({});
			values.set(token, value);
			return token;
		},
		unwrap: (stored) =>
			typeof stored === "object" && stored !== null ? values.get(stored) : undefined,
	};
}

export interface ReviewDraftSlot<T> {
	read: () => T | undefined;
	subscribe: (onChange: () => void) => () => void;
	update: (change: (current: T | undefined) => T | undefined) => void;
}

const NO_SUBSCRIPTION = () => () => {};
const NOTHING = () => undefined;

export function useReviewDraftSlot<T>(
	kind: ReviewDraftKind<T>,
	key: string,
	rendererScoped = false,
): ReviewDraftSlot<T> | null {
	const persistence = useContext(ReviewDraftContext);
	const slot = JSON.stringify([rendererScoped ? persistence?.rendererId : null, key]);
	return useMemo(
		() =>
			persistence && {
				read: () => kind.unwrap(persistence.read(slot)),
				subscribe: persistence.subscribe,
				update: (change) =>
					persistence.update(slot, (current) => {
						const previous = kind.unwrap(current);
						const next = change(previous);
						if (next === undefined) return undefined;
						return next === previous ? current : kind.wrap(next);
					}),
			},
		[kind, persistence, slot],
	);
}

export function useReviewDraftState<T>(
	kind: ReviewDraftKind<T>,
	key: string,
	initial: T,
	rendererScoped = false,
) {
	const draft = useReviewDraftSlot(kind, key, rendererScoped);
	const [local, setLocal] = useState(initial);
	const read = draft?.read ?? NOTHING;
	const stored = useSyncExternalStore(draft?.subscribe ?? NO_SUBSCRIPTION, read, read);
	const value = draft ? (stored ?? initial) : local;
	const change = useCallback(
		(reduce: (current: T) => T | undefined) => {
			if (draft) {
				draft.update((current) => {
					const next = reduce(current ?? initial);
					return next === initial ? undefined : next;
				});
			} else {
				setLocal((current) => reduce(current) ?? initial);
			}
		},
		[draft, initial],
	);
	return [value, change, draft !== null] as const;
}

export interface ReviewTextState {
	text: string;
	start: number;
	end: number;
	direction: "forward" | "backward" | "none";
	busy: boolean;
}

export interface ReviewTextBinding {
	read: () => ReviewTextState | undefined;
	subscribe: (onChange: () => void) => () => void;
	onChange: (value: ReviewTextState) => void;
	restored?: boolean;
}

export function useReviewText(binding: ReviewTextBinding | undefined): ReviewTextState | undefined {
	const read = binding?.read ?? NOTHING;
	return useSyncExternalStore(binding?.subscribe ?? NO_SUBSCRIPTION, read, read);
}

/** A review thread's unsent edit, shared by every renderer that shows the thread. */
export const THREAD_EDIT_DRAFT = reviewDraftKind<ReviewTextState | undefined>();

export function reviewTextState(text: string): ReviewTextState {
	return { text, start: text.length, end: text.length, direction: "none", busy: false };
}

export function selectedReviewText(
	input: HTMLTextAreaElement,
	state: ReviewTextState,
): ReviewTextState {
	const {
		value: text,
		selectionStart: start,
		selectionEnd: end,
		selectionDirection: direction,
	} = input;
	return state.text === text &&
		state.start === start &&
		state.end === end &&
		state.direction === direction
		? state
		: { ...state, text, start, end, direction };
}
