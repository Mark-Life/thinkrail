import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { compile, lit, obj, type Static, union } from "@earendil-works/pi-schema";
import {
	NativeUpdateInstallResult,
	NativeUpdateLog,
	NativeUpdateTime,
	NativeUpdateVersion,
} from "@thinkrail/contracts";

export const UPDATE_JOURNAL_FILE = "update-journal.json";
const MAX_JOURNAL_BYTES = 256 * 1024;

const OPEN = { open: true };

const UpdateJournal = union([
	obj(
		{
			schemaVersion: lit(1),
			state: lit("pending"),
			fromVersion: NativeUpdateVersion,
			toVersion: NativeUpdateVersion,
			startedAt: NativeUpdateTime,
			log: NativeUpdateLog,
		},
		OPEN,
	),
	obj({ schemaVersion: lit(1), state: lit("resolved"), result: NativeUpdateInstallResult }, OPEN),
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
