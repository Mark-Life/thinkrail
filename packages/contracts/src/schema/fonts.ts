import {
	arr,
	bool,
	lit,
	num,
	oneOf,
	opt,
	type Static,
	str,
	union,
} from "@earendil-works/pi-schema";
import { Ack, NoParams, NoPayload, wireObj } from "./wire";

export const UserFontFileErrorCode = oneOf([
	"too-large",
	"too-many",
	"unsupported-collection",
	"invalid-font",
	"unreadable",
]);
export type UserFontFileErrorCode = Static<typeof UserFontFileErrorCode>;

/** What a user font file declares in its own tables. */
export const UserFontFace = wireObj({
	family: str(),
	style: oneOf(["normal", "italic"]),
	/** One value for a static face; the `wght` axis range for a variable one. */
	weight: wireObj({ min: num(), max: num() }),
	monospace: bool(),
});
export type UserFontFace = Static<typeof UserFontFace>;

export const UserFontFileOk = wireObj({
	fileName: str(),
	ok: lit(true),
	/** Same-origin path serving the file, versioned by its content signature. */
	url: str(),
	face: UserFontFace,
});
export type UserFontFileOk = Static<typeof UserFontFileOk>;

export const UserFontFileError = wireObj({
	fileName: str(),
	ok: lit(false),
	error: UserFontFileErrorCode,
	/** Parser or OS detail for `invalid-font` / `unreadable`, untranslated. */
	detail: opt(str()),
});
export type UserFontFileError = Static<typeof UserFontFileError>;

export const UserFontFile = union([UserFontFileOk, UserFontFileError]);
export type UserFontFile = Static<typeof UserFontFile>;

/** The host's user font files (`<dataDir>/fonts/`), as `fonts.list` reports them. */
export const UserFontsSnapshot = wireObj({ dir: str(), files: arr(UserFontFile) });
export type UserFontsSnapshot = Static<typeof UserFontsSnapshot>;

/** A family the host operating system's font service reports. */
export const InstalledFontFamily = wireObj({
	name: str(),
	/** Advisory: clients confirm by measuring the face they actually render. */
	monospaceHint: bool(),
});
export type InstalledFontFamily = Static<typeof InstalledFontFamily>;

export const InstalledFontsResult = wireObj({ families: arr(InstalledFontFamily) });
export type InstalledFontsResult = Static<typeof InstalledFontsResult>;

export const FONTS_METHODS = {
	"fonts.list": { params: NoParams, result: UserFontsSnapshot },
	"fonts.installed": { params: NoParams, result: InstalledFontsResult },
	"fonts.reveal": { params: NoParams, result: Ack },
};

export const FONTS_CHANNELS = {
	"fonts.changed": NoPayload,
};
