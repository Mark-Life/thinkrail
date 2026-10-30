import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { NativeUpdateInstallResult, NativeUpdateLogEntry } from "@thinkrail/contracts";
import { Type } from "typebox";
import { Check } from "typebox/value";

export const UPDATE_JOURNAL_FILE = "update-journal.json";
export const MAX_UPDATE_LOG_ENTRIES = 200;
const MAX_JOURNAL_BYTES = 256 * 1024;
const MAX_TEXT_LENGTH = 4096;

const TextSchema = Type.String();
const RequiredTextSchema = Type.String({ minLength: 1 });
const NullableTextSchema = Type.Union([TextSchema, Type.Null()]);
const LogEventSchema = Type.Union([
	Type.Object({
		kind: Type.Union([
			Type.Literal("hostStopping"),
			Type.Literal("handoffStarted"),
			Type.Literal("restarting"),
		]),
	}),
	Type.Object({ kind: Type.Literal("hostStopped"), seconds: Type.Number() }),
	Type.Object({
		kind: Type.Union([Type.Literal("installStarted"), Type.Literal("installed")]),
		version: RequiredTextSchema,
	}),
	Type.Object({
		kind: Type.Literal("installFailed"),
		version: RequiredTextSchema,
		step: TextSchema,
		detail: TextSchema,
	}),
	Type.Object({ kind: Type.Literal("diagnostic"), text: TextSchema }),
]);
const LogSchema = Type.Array(
	Type.Object({
		at: Type.Number(),
		source: Type.Union([Type.Literal("update"), Type.Literal("host"), Type.Literal("installer")]),
		level: Type.Union([Type.Literal("info"), Type.Literal("error")]),
		event: LogEventSchema,
	}),
	{ maxItems: MAX_UPDATE_LOG_ENTRIES },
);
const UpdateJournalSchema = Type.Union([
	Type.Object({
		schemaVersion: Type.Literal(1),
		state: Type.Literal("pending"),
		fromVersion: RequiredTextSchema,
		toVersion: RequiredTextSchema,
		startedAt: Type.Number(),
		log: LogSchema,
	}),
	Type.Object({
		schemaVersion: Type.Literal(1),
		state: Type.Literal("resolved"),
		result: Type.Object({
			outcome: Type.Union([
				Type.Literal("installed"),
				Type.Literal("failed"),
				Type.Literal("unreported"),
			]),
			fromVersion: NullableTextSchema,
			toVersion: RequiredTextSchema,
			failedStep: NullableTextSchema,
			detail: NullableTextSchema,
			log: LogSchema,
		}),
	}),
]);

export type UpdateJournal =
	| {
			schemaVersion: 1;
			state: "pending";
			fromVersion: string;
			toVersion: string;
			startedAt: number;
			log: NativeUpdateLogEntry[];
	  }
	| { schemaVersion: 1; state: "resolved"; result: NativeUpdateInstallResult };

export interface UpdateJournalStore {
	read(): UpdateJournal | null;
	write(journal: UpdateJournal): void;
	clear(): void;
}

function eventTexts(entry: NativeUpdateLogEntry): Array<string | null> {
	switch (entry.event.kind) {
		case "installStarted":
		case "installed":
			return [entry.event.version];
		case "installFailed":
			return [entry.event.version, entry.event.step, entry.event.detail];
		case "diagnostic":
			return [entry.event.text];
		default:
			return [];
	}
}

function journalTexts(journal: UpdateJournal): Array<string | null> {
	if (journal.state === "pending") {
		return [journal.fromVersion, journal.toVersion, ...journal.log.flatMap(eventTexts)];
	}
	const { result } = journal;
	return [
		result.fromVersion,
		result.toVersion,
		result.failedStep,
		result.detail,
		...result.log.flatMap(eventTexts),
	];
}

export function parseUpdateJournal(value: unknown): UpdateJournal | null {
	if (!Check(UpdateJournalSchema, value)) return null;
	return journalTexts(value).every((text) => text === null || text.length <= MAX_TEXT_LENGTH)
		? value
		: null;
}

export function createUpdateJournalStore(
	path: string,
	reportError: (error: unknown) => void,
): UpdateJournalStore {
	const remove = (target: string): void => {
		try {
			rmSync(target, { force: true });
		} catch (error) {
			reportError(error);
		}
	};
	return {
		read: () => {
			try {
				const stat = statSync(path, { throwIfNoEntry: false });
				if (!stat?.isFile() || stat.size > MAX_JOURNAL_BYTES) return null;
				return parseUpdateJournal(JSON.parse(readFileSync(path, "utf8")));
			} catch (error) {
				reportError(error);
				return null;
			}
		},
		write: (journal) => {
			const partial = `${path}.partial`;
			try {
				writeFileSync(partial, JSON.stringify(journal));
				renameSync(partial, path);
			} catch (error) {
				reportError(error);
				remove(partial);
			}
		},
		clear: () => remove(path),
	};
}
