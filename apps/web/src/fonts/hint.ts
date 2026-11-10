import {
	JsonObject,
	normalizeFontSettings,
	parseUserFontFile,
	type UserFontFile,
	type UserFontFileOk,
} from "@thinkrail/contracts";
import { firstPaintPreferenceStorage } from "../clientPreferences";
import { STORAGE_PREFIX } from "../constants/branding";
import { DEFAULT_FONT_PREFERENCE, type FontPreference } from "./runtime";
import { namedFamilies } from "./stack";

const HINT_KEY = `${STORAGE_PREFIX}fonts`;
const HINT_VERSION = 1;

function cachedFaces(files: unknown) {
	if (!Array.isArray(files)) return [];
	return files.flatMap((value) => {
		const file = parseUserFontFile(value);
		return file?.ok ? [file] : [];
	});
}

export interface FontsHint {
	preference: FontPreference;
	files: UserFontFileOk[];
}

export function readFontsHint(): FontsHint {
	try {
		const raw = firstPaintPreferenceStorage()?.getItem(HINT_KEY);
		if (typeof raw !== "string") return { preference: DEFAULT_FONT_PREFERENCE, files: [] };
		const parsed: unknown = JSON.parse(raw);
		if (!JsonObject.check(parsed) || parsed.version !== HINT_VERSION) {
			return { preference: DEFAULT_FONT_PREFERENCE, files: [] };
		}
		return {
			preference: normalizeFontSettings(parsed.preference),
			files: cachedFaces(parsed.files),
		};
	} catch {
		return { preference: DEFAULT_FONT_PREFERENCE, files: [] };
	}
}

export function writeFontsHint(preference: FontPreference, files: readonly UserFontFile[]): void {
	const names = namedFamilies([preference.interfaceFont, preference.codeFont]);
	const used = files.filter(
		(file): file is UserFontFileOk => file.ok && names.has(file.face.family),
	);
	try {
		firstPaintPreferenceStorage()?.setItem(
			HINT_KEY,
			JSON.stringify({ version: HINT_VERSION, preference, files: used }),
		);
	} catch {
		return;
	}
}
