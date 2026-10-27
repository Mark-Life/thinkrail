import { expect, test } from "bun:test";
import { type FileBufferSummary, fileSaveIndicator, withFileBufferSummary } from "./fileBuffers";

const dirty = (status: FileBufferSummary["status"], pending?: true): FileBufferSummary => ({
	status,
	dirty: true,
	...(pending ? { pending } : {}),
});

test("a clean buffer shows nothing, a running save pulses", () => {
	expect(fileSaveIndicator(undefined)).toBeNull();
	expect(fileSaveIndicator({ status: "clean", dirty: false })).toBeNull();
	expect(fileSaveIndicator({ status: "saving", dirty: false })).toBeNull();
	expect(fileSaveIndicator(dirty("saving"))).toBe("saving");
});

test("an armed timer is pending only while the file can still be written", () => {
	expect(fileSaveIndicator(dirty("dirty", true))).toBe("pending");
	expect(fileSaveIndicator(dirty("error", true))).toBe("pending");
	expect(fileSaveIndicator(dirty("dirty"))).toBe("unsaved");
	expect(fileSaveIndicator(dirty("error"))).toBe("unsaved");
	for (const status of ["stale", "conflict", "deleted", "readonly"] as const) {
		expect(fileSaveIndicator(dirty(status, true))).toBe("unsaved");
	}
});

test("a pending flip is a summary change, an equal summary is not", () => {
	const summaries = withFileBufferSummary({}, "ws", "a.ts", dirty("dirty"));
	expect(withFileBufferSummary(summaries, "ws", "a.ts", dirty("dirty"))).toBe(summaries);
	expect(withFileBufferSummary(summaries, "ws", "a.ts", dirty("dirty", true))).not.toBe(summaries);
});
