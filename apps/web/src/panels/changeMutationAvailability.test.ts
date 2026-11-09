import { expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "@thinkrail/contracts";
import { canOfferChangeMutations } from "./changeMutationAvailability";

test("change mutations require a mutable scope, host capability, and loaded metadata", () => {
	expect(
		canOfferChangeMutations(
			{ kind: "turn", id: "t", baseTree: "a", headTree: "b", startedAt: 1 },
			PROTOCOL_VERSION,
			true,
		),
	).toBe(false);
	expect(canOfferChangeMutations({ kind: "uncommitted" }, PROTOCOL_VERSION, true)).toBe(true);
	expect(canOfferChangeMutations({ kind: "uncommitted" }, null, true)).toBe(false);
	expect(canOfferChangeMutations({ kind: "commit", sha: "abc" }, PROTOCOL_VERSION, true)).toBe(
		false,
	);
	expect(canOfferChangeMutations({ kind: "pinned", baseRef: "abc" }, PROTOCOL_VERSION, false)).toBe(
		false,
	);
});
