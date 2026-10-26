import { expect, test } from "bun:test";
import { type FileBufferSummary, fileSaveIndicator, withFileBufferSummary } from "./fileBuffers";

const dirty = (status: FileBufferSummary["status"], pending?: true): FileBufferSummary => ({
	status,
	dirty: true,
	...(pending ? { pending } : {}),
});

test("manual mode shows the unsaved dot, pulsing while a save runs", () => {
	expect(fileSaveIndicator(undefined, "manual")).toBeNull();
	expect(fileSaveIndicator({ status: "clean", dirty: false }, "manual")).toBeNull();
	expect(fileSaveIndicator(dirty("dirty", true), "manual")).toBe("unsaved");
	expect(fileSaveIndicator(dirty("saving"), "manual")).toBe("saving");
	expect(fileSaveIndicator(dirty("conflict"), "manual")).toBe("unsaved");
});

test("auto mode pulses only while a write is coming and shows the dot for a paused file", () => {
	expect(fileSaveIndicator({ status: "saving", dirty: false }, "auto")).toBeNull();
	expect(fileSaveIndicator(dirty("dirty", true), "auto")).toBe("pending");
	expect(fileSaveIndicator(dirty("saving"), "auto")).toBe("saving");
	expect(fileSaveIndicator(dirty("error", true), "auto")).toBe("pending");
	expect(fileSaveIndicator(dirty("dirty"), "auto")).toBe("unsaved");
	expect(fileSaveIndicator(dirty("error"), "auto")).toBe("unsaved");
	for (const status of ["stale", "conflict", "deleted", "readonly"] as const) {
		expect(fileSaveIndicator(dirty(status, true), "auto")).toBe("unsaved");
	}
});

test("a pending flip is a summary change, an equal summary is not", () => {
	const summaries = withFileBufferSummary({}, "ws", "a.ts", dirty("dirty"));
	expect(withFileBufferSummary(summaries, "ws", "a.ts", dirty("dirty"))).toBe(summaries);
	expect(withFileBufferSummary(summaries, "ws", "a.ts", dirty("dirty", true))).not.toBe(summaries);
});
