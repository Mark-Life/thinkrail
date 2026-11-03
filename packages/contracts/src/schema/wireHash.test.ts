import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { num, obj, str } from "@earendil-works/pi-schema";
import { PROTOCOL_VERSION } from "../wsProtocol";
import { WS_CHANNEL_SCHEMAS } from "./channels";
import { WsAck, WsEnvelope, WsRequestFrame, WsResume } from "./envelope";
import { AnyHostWelcome, HostWelcomeVersions } from "./host";
import { WS_METHOD_SCHEMAS } from "./methods";

const STORED = {
	protocolVersion: 103,
	hash: "7facb68a6ec08d74d7df79faaab7277fa7b3285b433318b3a5d688d1ed9d2392",
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
	const store = `then set STORED in wireHash.test.ts to ${JSON.stringify(current)}`;
	if (current.protocolVersion === stored.protocolVersion) {
		return `A wire schema changed but PROTOCOL_VERSION did not. Raise PROTOCOL_VERSION in wsProtocol.ts, ${store}. Raise PROTOCOL_MIN_VERSION too if older peers stop working.`;
	}
	return `PROTOCOL_VERSION changed. Check that older peers still work, ${store}.`;
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
	test("a wire schema change comes with a PROTOCOL_VERSION bump", () => {
		const current = { protocolVersion: PROTOCOL_VERSION, hash: wireHash(wire) };
		expect(staleWireProblem(STORED, current)).toBeNull();
	});

	test("an edited schema fails with the steps to take, and key order does not count", () => {
		const stored = { protocolVersion: 1, hash: wireHash({ a: { x: 1, y: 2 } }) };
		const reordered = { protocolVersion: 1, hash: wireHash({ a: { y: 2, x: 1 } }) };
		const fields = { protocolVersion: 1, hash: wireHash(obj({ x: str(), y: num() })) };
		const fieldsReordered = { protocolVersion: 1, hash: wireHash(obj({ y: num(), x: str() })) };
		const edited = { protocolVersion: 1, hash: wireHash({ a: { x: 1, y: 3 } }) };
		const bumped = { protocolVersion: 2, hash: edited.hash };

		expect(staleWireProblem(stored, reordered)).toBeNull();
		expect(staleWireProblem(fields, fieldsReordered)).toBeNull();
		expect(staleWireProblem(stored, edited)).toContain("Raise PROTOCOL_VERSION");
		expect(staleWireProblem(stored, bumped)).toContain("PROTOCOL_VERSION changed");
	});
});
