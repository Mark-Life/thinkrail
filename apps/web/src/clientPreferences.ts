import { type BridgeMethods, readGlobalNativeBridge, readNativeBridge } from "./nativeBridge";

export interface StablePreferenceAdapter {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

const STABLE_PREFERENCES_GLOBAL = "__THINKRAIL_STABLE_PREFERENCES__";

const PREFERENCE_ADAPTER_METHODS: BridgeMethods<StablePreferenceAdapter> = {
	getItem: "required",
	setItem: "required",
	removeItem: "required",
};

export function asStablePreferenceAdapter(value: unknown): StablePreferenceAdapter | null {
	return readNativeBridge(value, PREFERENCE_ADAPTER_METHODS);
}

export function getStablePreferenceAdapter(): StablePreferenceAdapter | null {
	return readGlobalNativeBridge(STABLE_PREFERENCES_GLOBAL, PREFERENCE_ADAPTER_METHODS);
}

export function firstPaintPreferenceStorage(): StablePreferenceAdapter | null {
	return (
		getStablePreferenceAdapter() ??
		asStablePreferenceAdapter(Reflect.get(globalThis, "localStorage"))
	);
}
