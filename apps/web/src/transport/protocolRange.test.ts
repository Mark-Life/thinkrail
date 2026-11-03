import { describe, expect, test } from "bun:test";
import { protocolMismatch } from "./protocolRange";

const client = { version: 110, min: 102, max: 199 };

type Case = [string, Parameters<typeof protocolMismatch>[0], ReturnType<typeof protocolMismatch>];

describe("protocolMismatch", () => {
	test.each<Case>([
		["same version", { protocolVersion: 110, protocolMin: 102, protocolMax: 199 }, null],
		["older host in range", { protocolVersion: 102, protocolMin: 102, protocolMax: 199 }, null],
		["newer host in range", { protocolVersion: 150, protocolMin: 102, protocolMax: 199 }, null],
		["older in-range host without a range", { protocolVersion: 102 }, null],
		["host above this UI's range", { protocolVersion: 200 }, "uiOutdated"],
		[
			"newer host that dropped this UI",
			{ protocolVersion: 150, protocolMin: 140, protocolMax: 199 },
			"uiOutdated",
		],
		["host below this UI's range", { protocolVersion: 101 }, "hostOutdated"],
		[
			"older host whose range ends below this UI",
			{ protocolVersion: 105, protocolMin: 102, protocolMax: 109 },
			"hostOutdated",
		],
	])("%s", (_name, host, expected) => {
		expect(protocolMismatch(host, client)).toBe(expected);
	});
});
