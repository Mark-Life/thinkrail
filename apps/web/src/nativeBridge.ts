/** Every member of a bridge, marked by whether the bridge must carry it. Each member is a function. */
export type BridgeMethods<T> = {
	readonly [K in keyof T]-?: T[K] extends ((...args: never) => unknown) | undefined
		? undefined extends T[K]
			? "optional"
			: "required"
		: never;
};

function isBridge<T>(value: unknown, methods: BridgeMethods<T>): value is T {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	try {
		return Object.entries(methods).every(([name, need]) => {
			const method: unknown = Reflect.get(value, name);
			return typeof method === "function" || (need === "optional" && method === undefined);
		});
	} catch {
		return false;
	}
}

/** `value` as the bridge `T` when it carries each method `methods` lists, else null. */
export function readNativeBridge<T>(value: unknown, methods: BridgeMethods<T>): T | null {
	return isBridge(value, methods) ? value : null;
}

/** The bridge the desktop preload freezes onto `globalThis[name]`, or null in a browser. */
export function readGlobalNativeBridge<T>(name: string, methods: BridgeMethods<T>): T | null {
	return readNativeBridge(Reflect.get(globalThis, name), methods);
}
