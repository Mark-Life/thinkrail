import { arr, lit, oneOf, opt, type Static, str, union, unknown } from "@earendil-works/pi-schema";
import { Ack, NoParams, wireObj } from "./wire";

export const UserThemeFileOk = wireObj({
	fileName: str(),
	ok: lit(true),
	/** The parsed JSON, unvalidated: the theme schema is owned by the web client. */
	manifest: unknown(),
});
export type UserThemeFileOk = Static<typeof UserThemeFileOk>;

export const UserThemeFileErrorCode = oneOf([
	"too-large",
	"too-many",
	"unreadable",
	"invalid-json",
]);
export type UserThemeFileErrorCode = Static<typeof UserThemeFileErrorCode>;

export const UserThemeFileError = wireObj({
	fileName: str(),
	ok: lit(false),
	error: UserThemeFileErrorCode,
	/** Parser or OS detail for `invalid-json` / `unreadable`, untranslated. */
	detail: opt(str()),
});
export type UserThemeFileError = Static<typeof UserThemeFileError>;

export const UserThemeFile = union([UserThemeFileOk, UserThemeFileError]);
export type UserThemeFile = Static<typeof UserThemeFile>;

/** The host's user theme files (`<dataDir>/themes/`), as `themes.list` reports them. */
export const UserThemesSnapshot = wireObj({ dir: str(), files: arr(UserThemeFile) });
export type UserThemesSnapshot = Static<typeof UserThemesSnapshot>;

export const THEMES_METHODS = {
	"themes.list": { params: NoParams, result: UserThemesSnapshot },
	"themes.reveal": { params: NoParams, result: Ack },
};
