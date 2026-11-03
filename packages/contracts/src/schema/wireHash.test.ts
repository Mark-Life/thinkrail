import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PROTOCOL_VERSION } from "../wsProtocol";
import { WS_CHANNEL_SCHEMAS } from "./channels";
import { WS_METHOD_SCHEMAS } from "./methods";

const STORED = {
	protocolVersion: 103,
	hash: "9d6b12658412d8a6e7554df3ad6a4e82d012c00f2229cc0534ab6493ed0dcd15",
};

function sortedKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortedKeys);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([key, child]) => [key, sortedKeys(child)]),
	);
}

function wireHash(wire: unknown) {
	return createHash("sha256")
		.update(JSON.stringify(sortedKeys(wire)))
		.digest("hex");
}

function staleWireProblem(stored: typeof STORED, current: typeof STORED) {
	if (current.hash === stored.hash && current.protocolVersion === stored.protocolVersion) {
		return null;
	}
	const store = `then set STORED in wireHash.test.ts to ${JSON.stringify(current)}`;
	if (current.protocolVersion === stored.protocolVersion) {
		return `A wire schema changed but PROTOCOL_VERSION did not. Raise PROTOCOL_VERSION in wsProtocol.ts, ${store}. Raise PROTOCOL_MIN_VERSION too if older peers stop working.`;
	}
	return `PROTOCOL_VERSION changed. Check that older peers still work, ${store}.`;
}

const wire = { methods: WS_METHOD_SCHEMAS, channels: WS_CHANNEL_SCHEMAS };

describe("wire hash", () => {
	test("a wire schema change comes with a PROTOCOL_VERSION bump", () => {
		const current = { protocolVersion: PROTOCOL_VERSION, hash: wireHash(wire) };
		expect(staleWireProblem(STORED, current)).toBeNull();
	});

	test("an edited schema fails with the steps to take, and key order does not count", () => {
		const stored = { protocolVersion: 1, hash: wireHash({ a: { x: 1, y: 2 } }) };
		const reordered = { protocolVersion: 1, hash: wireHash({ a: { y: 2, x: 1 } }) };
		const edited = { protocolVersion: 1, hash: wireHash({ a: { x: 1, y: 3 } }) };
		const bumped = { protocolVersion: 2, hash: edited.hash };

		expect(staleWireProblem(stored, reordered)).toBeNull();
		expect(staleWireProblem(stored, edited)).toContain("Raise PROTOCOL_VERSION");
		expect(staleWireProblem(stored, bumped)).toContain("PROTOCOL_VERSION changed");
	});
});
