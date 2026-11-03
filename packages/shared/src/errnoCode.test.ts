import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { errnoCode } from "./errnoCode";

class InheritedCodeError extends Error {}
Object.defineProperty(InheritedCodeError.prototype, "code", { value: "EINHERITED" });

function thrownBy(run: () => unknown) {
	try {
		run();
	} catch (cause) {
		return cause;
	}
	throw new Error("expected a throw");
}

test("errnoCode reads a string code and nothing else", () => {
	expect(errnoCode(thrownBy(() => readFileSync("/no/such/file")))).toBe("ENOENT");
	expect(errnoCode(new InheritedCodeError())).toBe("EINHERITED");
	expect(errnoCode({ code: "EEXIST" })).toBe("EEXIST");
	for (const cause of [new Error("x"), { code: 2 }, null, undefined, "ENOENT", 2]) {
		expect(errnoCode(cause)).toBeUndefined();
	}
});
