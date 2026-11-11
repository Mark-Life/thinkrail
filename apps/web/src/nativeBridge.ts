/** A function a bridge carries, as the web holds it: what it returns stays unknown until a check accepts it. */
export type BridgeCall = (...args: unknown[]) => unknown;

let reportRefused = (error: Error) => console.warn(error.message);

/** Where a bridge value the web refuses is reported; the app points it at its error reports. */
export function setNativeBridgeReporter(report: (error: Error) => void): void {
	reportRefused = report;
}

function refused(what: string) {
	return new Error(`desktop bridge value refused: ${what}`);
}

/** The function `value` carries under `name`, bound to `value`, or null when it carries none. */
export function bridgeCall(value: unknown, name: string): BridgeCall | null {
	if (typeof value !== "object" || value === null) return null;
	const member: unknown = Reflect.get(value, name);
	if (typeof member !== "function") return null;
	return (...args) => Reflect.apply(member, value, args);
}

/** The bridge the desktop preload freezes onto `globalThis[name]`; undefined in a browser. */
export function nativeGlobal(name: string): unknown {
	return Reflect.get(globalThis, name);
}

/** What a bridge call returned, once settled, when `check` accepts it; else a rejection. */
export async function settledAs<T>(
	check: (value: unknown) => value is T,
	result: unknown,
	what: string,
): Promise<T> {
	const value: unknown = await result;
	if (!check(value)) throw refused(what);
	return value;
}

/** Waits for a bridge call the web runs only for its effect. */
export async function settled(result: unknown): Promise<void> {
	await result;
}

/** What a synchronous bridge call returned when `check` accepts it; else `fallback`, and the refusal is reported. */
export function returnedAs<T>(
	check: (value: unknown) => value is T,
	result: unknown,
	what: string,
	fallback: T,
): T {
	if (check(result)) return result;
	reportRefused(refused(what));
	return fallback;
}

/** A listener to hand a bridge: it passes on what `check` accepts and reports the rest. */
export function checkedListener<T>(
	check: (value: unknown) => value is T,
	listener: (value: T) => void,
	what: string,
): (value: unknown) => void {
	return (value) => {
		if (check(value)) listener(value);
		else reportRefused(refused(what));
	};
}

/** The unsubscribe a bridge `subscribe` returned; a value that is not a function is reported. */
export function unsubscriber(result: unknown, what: string): () => void {
	if (typeof result === "function") return () => void Reflect.apply(result, undefined, []);
	reportRefused(refused(what));
	return () => {};
}
