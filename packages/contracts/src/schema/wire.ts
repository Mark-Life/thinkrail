import {
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

/** The params of a method that takes none: any object passes, and the handler reads none of it. */
export const NoParams = map(unknown());

/** The result of a method that reports only success. */
export const Ack = wireObj({ ok: lit(true) });
export type Ack = Static<typeof Ack>;
