import { expect, test } from "bun:test";
import { WS_METHOD_SCHEMAS } from "./methods";

test("a change to a wire schema shows in this snapshot and needs a protocol version decision", () => {
	const lines = Object.entries(WS_METHOD_SCHEMAS).map(
		([method, schemas]) => `${method}: ${JSON.stringify(schemas)}`,
	);
	expect(lines.join("\n")).toMatchSnapshot();
});
