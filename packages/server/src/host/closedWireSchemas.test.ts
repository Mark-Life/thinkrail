import { expect, test } from "bun:test";
import {
	arr,
	compile,
	map,
	obj,
	opt,
	type Schema,
	str,
	union,
	unknown,
} from "@earendil-works/pi-schema";
import { closedSchema } from "./closedWireSchemas";

const accepts = (schema: Schema, value: unknown) => compile(closedSchema(schema)).check(value);

test("an open object refuses unknown fields at every depth", () => {
	const inner = obj({ id: str() }, { open: true });
	const schema = obj({ one: inner, many: opt(arr(inner)) }, { open: true });

	expect(accepts(schema, { one: { id: "a" } })).toBe(true);
	expect(accepts(schema, { one: { id: "a" }, stray: 1 })).toBe(false);
	expect(accepts(schema, { one: { id: "a", stray: 1 } })).toBe(false);
	expect(accepts(schema, { one: { id: "a" }, many: [{ id: "b", stray: 1 }] })).toBe(false);
});

test("a union branch and a record value close too", () => {
	const inner = obj({ id: str() }, { open: true });

	expect(accepts(union([inner, str()]), { id: "a", stray: 1 })).toBe(false);
	expect(accepts(map(inner), { key: { id: "a", stray: 1 } })).toBe(false);
	expect(accepts(map(inner), { key: { id: "a" } })).toBe(true);
});

test("a bare object and a record keep their keys open", () => {
	expect(accepts({ type: "object" }, { anything: 1 })).toBe(true);
	expect(accepts(map(unknown()), { anything: 1 })).toBe(true);
});
