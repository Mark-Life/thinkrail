import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DESKTOP_DIALOG_KEYS, EN, type EnglishCatalog } from "@thinkrail/locales";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { desktopError } from "./errorReporting";

const MAX_DIALOG_LABEL_LENGTH = 200;
const NativeLabelsSchema = Type.Record(Type.String(), Type.Unknown());
const LabelSchema = Type.String();

export function readLabels<K extends keyof EnglishCatalog & string>(
	keys: readonly K[],
	maxLength: number,
	raw: unknown,
): Readonly<Record<K, string>> {
	const source = Check(NativeLabelsSchema, raw) ? raw : {};
	return Object.fromEntries(
		keys.map((key) => {
			const value = source[key];
			return [
				key,
				Check(LabelSchema, value) && value.trim() && value.length <= maxLength
					? value
					: (EN[key] ?? key),
			];
		}),
	) as Record<K, string>;
}

export type DesktopDialogLabels = Readonly<Record<(typeof DESKTOP_DIALOG_KEYS)[number], string>>;

export function readDialogLabels(raw: unknown): DesktopDialogLabels {
	return readLabels(DESKTOP_DIALOG_KEYS, MAX_DIALOG_LABEL_LENGTH, raw);
}

export const DEFAULT_DIALOG_LABELS: DesktopDialogLabels = readDialogLabels({});

export function readNativeLabels(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
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
