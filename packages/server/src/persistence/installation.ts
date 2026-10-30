import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";

export interface InstallationRecord {
	id: string;
}

interface PersistedInstallationRecord extends InstallationRecord {
	appInstalled?: true;
}

const InstallationIdSchema = Type.Object({ id: Type.String({ minLength: 1 }) });
const AppInstalledSchema = Type.Object({ appInstalled: Type.Literal(true) });

function readInstallationFile(directory: string): unknown {
	try {
		return JSON.parse(readFileSync(join(directory, "installation.json"), "utf8"));
	} catch {
		return undefined;
	}
}

function readInstallationId(directory: string): string | undefined {
	const parsed = readInstallationFile(directory);
	return Check(InstallationIdSchema, parsed) ? parsed.id : undefined;
}

function isAlreadyExists(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

export function ensureInstallationIn(
	directory: string,
	publish: typeof linkSync = linkSync,
): InstallationRecord {
	mkdirSync(directory, { recursive: true });
	const existing = readInstallationId(directory);
	if (existing !== undefined) return { id: existing };

	const target = join(directory, "installation.json");
	const temp = join(directory, `.installation.json.${process.pid}.${randomUUID()}.tmp`);
	const record: InstallationRecord = { id: randomUUID() };
	try {
		writeFileSync(temp, `${JSON.stringify(record, null, "\t")}\n`, { flag: "wx" });
		try {
			publish(temp, target);
			return record;
		} catch (error) {
			if (!isAlreadyExists(error)) throw error;
			const winner = readInstallationId(directory);
			if (winner !== undefined) return { id: winner };
			throw new Error("installation.json exists without a valid installation id", { cause: error });
		}
	} finally {
		try {
			unlinkSync(temp);
		} catch {}
	}
}

export function claimAppInstalledIn(
	directory: string,
	replace: typeof renameSync = renameSync,
): boolean {
	if (Check(AppInstalledSchema, readInstallationFile(directory))) return false;
	const { id } = ensureInstallationIn(directory);
	const claim = join(directory, ".installation-app-installed.claim");
	try {
		writeFileSync(claim, "", { flag: "wx" });
	} catch (error) {
		if (isAlreadyExists(error)) return false;
		throw error;
	}

	const target = join(directory, "installation.json");
	const temp = join(directory, `.installation.json.${process.pid}.${randomUUID()}.tmp`);
	try {
		writeFileSync(
			temp,
			`${JSON.stringify({ id, appInstalled: true } satisfies PersistedInstallationRecord, null, "\t")}\n`,
			{ flag: "wx" },
		);
		replace(temp, target);
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {}
		try {
			unlinkSync(claim);
		} catch {}
		throw error;
	}
	return true;
}
