import { bridgeCall, nativeGlobal, returnedAs } from "./nativeBridge";

export interface StablePreferenceAdapter {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

const STABLE_PREFERENCES_GLOBAL = "__THINKRAIL_STABLE_PREFERENCES__";

const isStoredValue = (value: unknown) => typeof value === "string" || value === null;

/** The string store at `value` (the desktop adapter or `localStorage`), checking what it reads, or null. */
export function asStablePreferenceAdapter(value: unknown): StablePreferenceAdapter | null {
	const getItem = bridgeCall(value, "getItem");
	const setItem = bridgeCall(value, "setItem");
	const removeItem = bridgeCall(value, "removeItem");
	if (!getItem || !setItem || !removeItem) return null;
	return {
		getItem: (key) => returnedAs(isStoredValue, getItem(key), "stored preference", null),
		setItem: (key, item) => void setItem(key, item),
		removeItem: (key) => void removeItem(key),
	};
}

export function getStablePreferenceAdapter(): StablePreferenceAdapter | null {
	return asStablePreferenceAdapter(nativeGlobal(STABLE_PREFERENCES_GLOBAL));
}

export function firstPaintPreferenceStorage(): StablePreferenceAdapter | null {
	return (
		getStablePreferenceAdapter() ??
		asStablePreferenceAdapter(Reflect.get(globalThis, "localStorage"))
	);
}
