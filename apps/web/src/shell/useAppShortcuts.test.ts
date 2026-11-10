import { afterEach, expect, test } from "bun:test";
import { setNativeBridgeReporter } from "../nativeBridge";
import { getNativeShortcutsBridge } from "./useAppShortcuts";

afterEach(() => setNativeBridgeReporter((error) => console.warn(error.message)));

test("getNativeShortcutsBridge accepts only the full bridge shape", () => {
	expect(getNativeShortcutsBridge(undefined)).toBeNull();
	expect(getNativeShortcutsBridge([])).toBeNull();
	expect(getNativeShortcutsBridge({ subscribeQuitHint: () => {} })).toBeNull();
	expect(
		getNativeShortcutsBridge({ subscribeQuitHint: () => {}, subscribeCommand: () => {} }),
	).toBeNull();
	expect(
		getNativeShortcutsBridge({
			subscribeQuitHint: () => () => {},
			subscribeCommand: () => () => {},
			quit: async () => {},
		}),
	).not.toBeNull();
});

test("a pushed value the bridge contract does not allow is reported, not passed on", () => {
	const refused: string[] = [];
	setNativeBridgeReporter((error) => refused.push(error.message));
	let push: (value: unknown) => void = () => {};
	const bridge = getNativeShortcutsBridge({
		subscribeQuitHint: (listener: (value: unknown) => void) => {
			push = listener;
			return () => {};
		},
		subscribeCommand: () => "not a function",
		quit: async () => {},
	});
	const hints: string[] = [];
	bridge?.subscribeQuitHint((hint) => hints.push(hint));
	push("armed");
	push("exploded");
	bridge?.subscribeCommand(() => {});
	expect(hints).toEqual(["armed"]);
	expect(refused).toEqual([
		"desktop bridge value refused: quit hint",
		"desktop bridge value refused: native command unsubscribe",
	]);
});
