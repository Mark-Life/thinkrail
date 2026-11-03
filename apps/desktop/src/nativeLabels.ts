import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { compile, map, unknown } from "@earendil-works/pi-schema";
import { DESKTOP_DIALOG_KEYS, EN, type EnglishCatalog } from "@thinkrail/locales";
import { desktopError } from "./errorReporting";

const MAX_DIALOG_LABEL_LENGTH = 200;
const LabelFile = compile(map(unknown()));

export type RawLabels = Readonly<Record<string, unknown>>;

export function readLabels<K extends keyof EnglishCatalog & string>(
	keys: readonly K[],
	maxLength: number,
	raw: RawLabels,
): Readonly<Record<K, string>> {
	return Object.fromEntries(
		keys.map((key) => {
			const value = raw[key];
			return [
				key,
				typeof value === "string" && value.trim() && value.length <= maxLength
					? value
					: (EN[key] ?? key),
			];
		}),
	) as Record<K, string>;
}

export type DesktopDialogLabels = Readonly<Record<(typeof DESKTOP_DIALOG_KEYS)[number], string>>;

export function readDialogLabels(raw: RawLabels): DesktopDialogLabels {
	return readLabels(DESKTOP_DIALOG_KEYS, MAX_DIALOG_LABEL_LENGTH, raw);
}

export const DEFAULT_DIALOG_LABELS: DesktopDialogLabels = readDialogLabels({});

export function readNativeLabels(path: string): RawLabels {
	try {
		const labels: unknown = JSON.parse(readFileSync(path, "utf8"));
		return LabelFile.check(labels) ? labels : {};
	} catch {
		return {};
	}
}

export function writeNativeLabels(path: string, labels: Readonly<Record<string, string>>): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(labels));
	} catch (error) {
		desktopError("labels", "could not save the native labels", error);
	}
}
