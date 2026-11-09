import { arr, bool, map, opt, type Static, str } from "@earendil-works/pi-schema";
import { NoParams, wireObj } from "./wire";

/** Values of settings bundled extensions declare, by extension name then setting key. */
export const ExtensionSettingValues = map(map(bool()));
export type ExtensionSettingValues = Static<typeof ExtensionSettingValues>;

export const ExtensionSettingDescriptor = wireObj({ key: str(), default: bool() });
export type ExtensionSettingDescriptor = Static<typeof ExtensionSettingDescriptor>;

export const ExtensionCatalogEntry = wireObj({
	name: str(),
	title: str(),
	description: opt(str()),
	enabled: bool(),
	tools: arr(str()),
	hasChildExtensions: bool(),
	settings: opt(arr(ExtensionSettingDescriptor)),
});
export type ExtensionCatalogEntry = Static<typeof ExtensionCatalogEntry>;

export const EXTENSION_METHODS = {
	"extension.list": { params: NoParams, result: arr(ExtensionCatalogEntry) },
};
