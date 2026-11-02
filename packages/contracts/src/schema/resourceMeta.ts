import { bool, nullable, num, opt, type Static, str } from "@earendil-works/pi-schema";
import { wireObj } from "./wire";

export const ResourceMeta = wireObj({
	hash: nullable(str()),
	byteLength: nullable(num()),
	text: bool(),
	mime: opt(str()),
});
export type ResourceMeta = Static<typeof ResourceMeta>;
