import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { num, obj, str } from "@earendil-works/pi-schema";
import { WS_CHANNEL_SCHEMAS } from "./channels";
import { WsAck, WsEnvelope, WsRequestFrame, WsResume } from "./envelope";
import { AnyHostWelcome, HostWelcomeVersions, PROTOCOL_VERSION } from "./host";
import { WS_METHOD_SCHEMAS } from "./methods";

const STORED = {
	protocolVersion: 103,
	hash: "3d3409b5a0b5281f9b0576ae8e0f3c5a921b3e84ac409dd97c9bfbec66aad9c6",
};

function sortedKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortedKeys);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([key, child]) => [
				key,
				key === "required" && Array.isArray(child) ? child.toSorted() : sortedKeys(child),
			]),
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
	return `The wire changed. Decide if the change is breaking, by the rules in schema/SPEC.md. Raise PROTOCOL_VERSION in schema/host.ts only if it is. Either way, set STORED in wireHash.test.ts to the hash and version of that decision. Now: ${JSON.stringify(current)}.`;
}

const wire = {
	methods: WS_METHOD_SCHEMAS,
	channels: WS_CHANNEL_SCHEMAS,
	acceptedWelcome: AnyHostWelcome,
	welcomeVersions: HostWelcomeVersions,
	hostFrames: WsEnvelope,
	clientFrames: { request: WsRequestFrame, ack: WsAck, resume: WsResume },
};

describe("wire hash", () => {
	test("a wire schema edit comes with a decision on PROTOCOL_VERSION", () => {
		const current = { protocolVersion: PROTOCOL_VERSION, hash: wireHash(wire) };
		expect(staleWireProblem(STORED, current)).toBeNull();
	});

	test("an edit fails with the decision to make, bumped or not, and key order does not count", () => {
		const stored = { protocolVersion: 1, hash: wireHash({ a: { x: 1, y: 2 } }) };
		const reordered = { protocolVersion: 1, hash: wireHash({ a: { y: 2, x: 1 } }) };
		const fields = { protocolVersion: 1, hash: wireHash(obj({ x: str(), y: num() })) };
		const fieldsReordered = { protocolVersion: 1, hash: wireHash(obj({ y: num(), x: str() })) };
		const edited = { protocolVersion: 1, hash: wireHash({ a: { x: 1, y: 3 } }) };
		const bumped = { protocolVersion: 2, hash: edited.hash };

		expect(staleWireProblem(stored, reordered)).toBeNull();
		expect(staleWireProblem(fields, fieldsReordered)).toBeNull();
		expect(staleWireProblem(stored, edited)).toContain("Decide if the change is breaking");
		expect(staleWireProblem(stored, edited)).toContain(JSON.stringify(edited));
		expect(staleWireProblem(stored, bumped)).toContain(JSON.stringify(bumped));
	});
});
