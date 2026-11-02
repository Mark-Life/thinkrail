import { arr, bool, opt, type Static, str } from "@earendil-works/pi-schema";
import { NoParams, wireObj } from "./wire";

export const ExtensionCatalogEntry = wireObj({
	name: str(),
	title: str(),
	description: opt(str()),
	enabled: bool(),
	tools: arr(str()),
	hasChildExtensions: bool(),
});
export type ExtensionCatalogEntry = Static<typeof ExtensionCatalogEntry>;

export const EXTENSION_METHODS = {
	"extension.list": { params: NoParams, result: arr(ExtensionCatalogEntry) },
};
