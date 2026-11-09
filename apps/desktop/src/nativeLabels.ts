import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { JsonObject } from "@thinkrail/contracts";
import { type DESKTOP_DIALOG_KEYS, EN, type EnglishCatalog } from "@thinkrail/locales";
import { desktopError } from "./errorReporting";

const MAX_DIALOG_LABEL_LENGTH = 200;

export type RawLabels = Readonly<Record<string, unknown>>;

export function labelReader(maxLength: number, raw: RawLabels) {
	return (key: keyof EnglishCatalog & string): string => {
		const value = raw[key];
		return typeof value === "string" && value.trim() && value.length <= maxLength
			? value
			: (EN[key] ?? key);
	};
}

export type DesktopDialogLabels = Readonly<Record<(typeof DESKTOP_DIALOG_KEYS)[number], string>>;

export function readDialogLabels(raw: RawLabels): DesktopDialogLabels {
	const label = labelReader(MAX_DIALOG_LABEL_LENGTH, raw);
	return {
		"desktop.dialog.quit": label("desktop.dialog.quit"),
		"desktop.dialog.startFailed": label("desktop.dialog.startFailed"),
		"desktop.dialog.updateRestartFailed": label("desktop.dialog.updateRestartFailed"),
		"desktop.dialog.updateRestartFailedTitle": label("desktop.dialog.updateRestartFailedTitle"),
		"desktop.splash.finishingUpdate": label("desktop.splash.finishingUpdate"),
		"desktop.splash.starting": label("desktop.splash.starting"),
	};
}

export const DEFAULT_DIALOG_LABELS: DesktopDialogLabels = readDialogLabels({});

export function readNativeLabels(path: string): RawLabels {
	try {
		const labels: unknown = JSON.parse(readFileSync(path, "utf8"));
		return JsonObject.check(labels) ? labels : {};
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
