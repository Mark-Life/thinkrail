import {
	arr,
	lit,
	map,
	nullable,
	oneOf,
	opt,
	type Static,
	str,
	union,
} from "@earendil-works/pi-schema";
import { Ack, NoParams, NoPayload, wireObj } from "./wire";

export const LocalLocaleFileOk = wireObj({
	fileName: str(),
	tag: str(),
	ok: lit(true),
	strings: map(str()),
});
export type LocalLocaleFileOk = Static<typeof LocalLocaleFileOk>;

export const LocalLocaleFileErrorCode = oneOf([
	"invalid-name",
	"duplicate",
	"too-large",
	"too-many",
	"unreadable",
	"invalid-json",
	"not-object",
]);
export type LocalLocaleFileErrorCode = Static<typeof LocalLocaleFileErrorCode>;

export const LocalLocaleFileError = wireObj({
	fileName: str(),
	tag: nullable(str()),
	ok: lit(false),
	error: LocalLocaleFileErrorCode,
	/** Parser or OS detail for `invalid-json` / `unreadable`, untranslated. */
	detail: opt(str()),
});
export type LocalLocaleFileError = Static<typeof LocalLocaleFileError>;

export const LocalLocaleFile = union([LocalLocaleFileOk, LocalLocaleFileError]);
export type LocalLocaleFile = Static<typeof LocalLocaleFile>;

/** The host's local language files (`<dataDir>/locales/`), as `locales.list` reports them. */
export const LocalLocalesSnapshot = wireObj({ dir: str(), files: arr(LocalLocaleFile) });
export type LocalLocalesSnapshot = Static<typeof LocalLocalesSnapshot>;

export const LOCALES_METHODS = {
	"locales.list": { params: NoParams, result: LocalLocalesSnapshot },
	"locales.reveal": { params: NoParams, result: Ack },
};

export const LOCALES_CHANNELS = {
	"locales.changed": NoPayload,
};
