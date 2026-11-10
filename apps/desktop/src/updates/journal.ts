import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import {
	arr,
	compile,
	lit,
	nullable,
	num,
	obj,
	oneOf,
	type Schema,
	type Static,
	str,
	union,
} from "@earendil-works/pi-schema";
import type {
	NativeUpdateInstallResult,
	NativeUpdateLogEntry,
	NativeUpdateLogEvent,
	Same,
} from "@thinkrail/contracts";

export const UPDATE_JOURNAL_FILE = "update-journal.json";
export const MAX_UPDATE_LOG_ENTRIES = 200;
const MAX_JOURNAL_BYTES = 256 * 1024;
const MAX_TEXT_LENGTH = 4096;

const OPEN = { open: true };
const Text = str({ maxLength: MAX_TEXT_LENGTH });
const Version = str({ minLength: 1, maxLength: MAX_TEXT_LENGTH });
const Finite = num({ minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE });

const LogEvent = union([
	obj({ kind: lit("installStarted"), version: Version }, OPEN),
	obj({ kind: lit("hostStopping") }, OPEN),
	obj({ kind: lit("hostStopped"), seconds: Finite }, OPEN),
	obj({ kind: lit("handoffStarted") }, OPEN),
	obj({ kind: lit("restarting") }, OPEN),
	obj({ kind: lit("installed"), version: Version }, OPEN),
	obj({ kind: lit("installFailed"), version: Version, step: Text, detail: Text }, OPEN),
	obj({ kind: lit("diagnostic"), text: Text }, OPEN),
]);

export type LogEventTie = Same<Static<typeof LogEvent>, NativeUpdateLogEvent>;

const LogEntry = obj(
	{
		at: Finite,
		source: oneOf(["update", "host", "installer"]),
		level: oneOf(["info", "error"]),
		event: LogEvent,
	},
	OPEN,
);

export type LogEntryTie = Same<Static<typeof LogEntry>, NativeUpdateLogEntry>;

const Log: Schema<readonly LogEntryTie[]> = arr(LogEntry, { maxItems: MAX_UPDATE_LOG_ENTRIES });

const InstallResult = obj(
	{
		outcome: oneOf(["installed", "failed", "unreported"]),
		fromVersion: nullable(Text),
		toVersion: Version,
		failedStep: nullable(Text),
		detail: nullable(Text),
		log: Log,
	},
	OPEN,
);
export type InstallResultTie = Same<Static<typeof InstallResult>, NativeUpdateInstallResult>;

const UpdateJournal = union([
	obj(
		{
			schemaVersion: lit(1),
			state: lit("pending"),
			fromVersion: Version,
			toVersion: Version,
			startedAt: Finite,
			log: Log,
		},
		OPEN,
	),
	obj({ schemaVersion: lit(1), state: lit("resolved"), result: InstallResult }, OPEN),
]);
export type UpdateJournal = Static<typeof UpdateJournal>;

const journalFile = compile(UpdateJournal);

export interface UpdateJournalStore {
	read(): UpdateJournal | null;
	write(journal: UpdateJournal): void;
	clear(): void;
}

export function parseUpdateJournal(value: unknown): UpdateJournal | null {
	return journalFile.check(value) ? value : null;
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
