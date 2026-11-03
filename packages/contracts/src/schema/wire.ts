import {
	arr,
	lit,
	obj,
	type Properties,
	type Schema,
	type Static,
	type StaticObject,
} from "@earendil-works/pi-schema";

/** A wire object: unknown fields pass, so a UI and a host of different builds keep working together. */
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

/** The params of a method that takes none. */
export const NoParams: Schema<Record<string, never>> = wireObj({});

/** The payload of a channel that only says something changed. */
export const NoPayload = NoParams;

/** The result of a method that reports only success. */
export const Ack = wireObj({ ok: lit(true) });
export type Ack = Static<typeof Ack>;

export function readonlyArr<T>(items: Schema<T>): Schema<readonly T[]> {
	return arr(items);
}

export function piOwned<T>(): Schema<T> {
	return { type: "object" };
}
