import { expect, test } from "bun:test";
import { createAutosave } from "./autosave";
import { fakeClock } from "./registryFixtures";

function scheduler() {
	const clock = fakeClock();
	const fired: string[] = [];
	const changed: string[] = [];
	const autosave = createAutosave({
		delayMs: 1000,
		schedule: clock.schedule,
		fire: (key) => fired.push(key),
		changed: (key) => changed.push(key),
	});
	return { clock, fired, changed, autosave };
}

test("each arm restarts the delay, and the timer fires once after the last one", () => {
	const { clock, fired, changed, autosave } = scheduler();
	autosave.arm("a");
	clock.advance(600);
	autosave.arm("a");
	clock.advance(600);
	expect(fired).toEqual([]);
	expect(autosave.isArmed("a")).toBe(true);
	clock.advance(400);
	expect(fired).toEqual(["a"]);
	expect(autosave.isArmed("a")).toBe(false);
	expect(changed).toEqual(["a", "a"]);
	clock.advance(5000);
	expect(fired).toEqual(["a"]);
});

test("flush fires an armed timer at once and does nothing when none is armed", () => {
	const { clock, fired, autosave } = scheduler();
	autosave.flush("a");
	autosave.flushAll();
	expect(fired).toEqual([]);
	autosave.arm("a");
	autosave.arm("b");
	autosave.flush("a");
	expect(fired).toEqual(["a"]);
	autosave.flushAll();
	expect(fired).toEqual(["a", "b"]);
	clock.advance(2000);
	expect(fired).toEqual(["a", "b"]);
	expect(clock.timers()).toBe(0);
});

test("cancel and cancelAll drop timers without firing them", () => {
	const { clock, fired, changed, autosave } = scheduler();
	autosave.cancel("a");
	expect(changed).toEqual([]);
	autosave.arm("a");
	autosave.arm("b");
	autosave.cancel("a");
	autosave.cancelAll();
	clock.advance(2000);
	expect(fired).toEqual([]);
	expect(changed).toEqual(["a", "b", "a", "b"]);
	expect(clock.timers()).toBe(0);
});

test("a fire that arms again stays armed", () => {
	const clock = fakeClock();
	let again = true;
	const autosave = createAutosave({
		delayMs: 1000,
		schedule: clock.schedule,
		fire: (key) => {
			if (again) autosave.arm(key);
			again = false;
		},
		changed: () => {},
	});
	autosave.arm("a");
	clock.advance(1000);
	expect(autosave.isArmed("a")).toBe(true);
	clock.advance(1000);
	expect(autosave.isArmed("a")).toBe(false);
});
