import {
	lit,
	obj,
	type Properties,
	type Schema,
	type Static,
	type StaticObject,
} from "@earendil-works/pi-schema";

/** A wire object: unknown fields pass, so a UI and a host of different versions keep working together. */
export function wireObj<const P extends Properties>(properties: P): Schema<StaticObject<P>> {
	return obj(properties, { open: true });
}

/** The params of a method that takes none. */
export const NoParams: Schema<Record<string, never>> = wireObj({});

/** The result of a method that reports only success. */
export const Ack = wireObj({ ok: lit(true) });
export type Ack = Static<typeof Ack>;
