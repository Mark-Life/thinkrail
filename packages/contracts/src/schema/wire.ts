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
 * A `$ref` to the nearest `$id` (or the document root): the one place a recursive schema's type is claimed rather
 * than built, since pi-schema has no recursive builder.
 */
export function selfRef<T>(): Schema<T> {
	return { $ref: "#" };
}

/** `schema` named by `$id`, so a `selfRef` inside it points at it, not at a schema that embeds it. */
export function withId<S extends Schema>(schema: S, $id: string): S {
	return { ...schema, $id };
}

/** `schema` with more JSON Schema rules: it accepts less, so its values keep `schema`'s type. */
export function narrowed<S extends Schema>(schema: S, rules: Schema): S {
	return { ...schema, allOf: [rules] };
}
