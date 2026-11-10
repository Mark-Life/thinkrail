import { expect, test } from "bun:test";
import type { Same } from "./typeTie";

test("Same accepts the same shape written as an intersection", () => {
	const value: Same<{ a: string } & { b?: number }, { a: string; b?: number }> = { a: "x" };
	expect(value).toEqual({ a: "x" });
});

test("Same refuses a field either side adds or changes", () => {
	// @ts-expect-error the owning type adds an optional field
	const added: Same<{ a: string }, { a: string; b?: number }> = { a: "x" };
	// @ts-expect-error the declared shape keeps a field the owning type dropped
	const dropped: Same<{ a: string; b?: number }, { a: string }> = { a: "x" };
	// @ts-expect-error a required field became optional
	const optional: Same<{ a: string | undefined }, { a?: string }> = { a: "x" };
	// @ts-expect-error a nested field drifted
	const nested: Same<{ a: { b: string } }, { a: { b: string; c?: 1 } }> = { a: { b: "x" } };
	// @ts-expect-error the owning union gained a member
	const member: Same<"x", "x" | "y"> = "x";
	expect([added, dropped, optional, nested, member]).toHaveLength(5);
});
