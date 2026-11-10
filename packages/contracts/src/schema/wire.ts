import {
	arr,
	lit,
	map,
	obj,
	type Properties,
	type Schema,
	type Static,
	type StaticObject,
	unknown,
} from "@earendil-works/pi-schema";

/** A wire object: unknown fields pass, so a UI and a host of different versions keep working together. */
export function wireObj<const P extends Properties>(properties: P): Schema<StaticObject<P>> {
	return obj(properties, { open: true });
}

/** A wire object whose fields are all optional, as `Partial` of the `wireObj` type. */
export function partialWireObj<const P extends Properties>(
	properties: P,
): Schema<Partial<StaticObject<P>>> {
	const { required: _required, ...schema } = wireObj(properties);
	return schema;
}

/** The params of a method that takes none: any object passes, and the handler reads none of it. */
export const NoParams = map(unknown());

/** The payload of a channel that only says something changed. */
export const NoPayload = NoParams;

/** The result of a method that reports only success. */
export const Ack = wireObj({ ok: lit(true) });
export type Ack = Static<typeof Ack>;

export function readonlyArr<T>(items: Schema<T>): Schema<readonly T[]> {
	return arr(items);
}

/**
 * A recursive schema named by `$id`: `build` gets a `$ref` back to the result. pi-schema has no recursive builder,
 * so the `$ref` states `T`; the caller ties `Static` of the result to `T` with `Same`, which makes the claim exact.
 */
export function recursive<T, S extends Schema>($id: string, build: (self: Schema<T>) => S): S {
	return { ...build({ $ref: "#" }), $id };
}

/** `schema` with more JSON Schema rules, added to any `allOf` it has: it accepts less, so its values keep `schema`'s type. */
export function narrowed<S extends Schema>(schema: S, rules: Schema): S {
	const { allOf } = schema;
	return { ...schema, allOf: Array.isArray(allOf) ? [...allOf, rules] : [rules] };
}
