import { describe, expect, test } from "bun:test";
import type { StopReason } from "@earendil-works/pi-ai";
import { assistantToolCallsAreExecutable, isTranscriptMessageRole } from "./piProtocol";

describe("assistantToolCallsAreExecutable", () => {
	test("rejects every Pi terminal that cannot execute tool calls", () => {
		const terminals: StopReason[] = ["error", "aborted", "length"];
		for (const stopReason of terminals) {
			expect(assistantToolCallsAreExecutable(stopReason)).toBe(false);
		}
	});

	test("allows executable and in-flight assistant states", () => {
		const states: (StopReason | undefined)[] = [undefined, "toolUse", "stop"];
		for (const stopReason of states) {
			expect(assistantToolCallsAreExecutable(stopReason)).toBe(true);
		}
	});
});

test("isTranscriptMessageRole accepts only the roles a transcript carries", () => {
	expect(isTranscriptMessageRole("assistant")).toBe(true);
	expect(isTranscriptMessageRole("compactionSummary")).toBe(true);
	expect(isTranscriptMessageRole("bashExecution")).toBe(false);
	expect(isTranscriptMessageRole("toString")).toBe(false);
});
