import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compile, lit, obj, str } from "@earendil-works/pi-schema";
import { hasErrorCode } from "./stateFile";

export interface InstallationRecord {
	id: string;
}

const InstallationIdFile = compile(obj({ id: str({ minLength: 1 }) }, { open: true }));
const AppInstalledFile = compile(obj({ appInstalled: lit(true) }, { open: true }));

function readInstallation(directory: string): unknown {
	try {
		return JSON.parse(readFileSync(join(directory, "installation.json"), "utf8"));
	} catch {
		return undefined;
	}
}

export function ensureInstallationIn(
	directory: string,
	publish: typeof linkSync = linkSync,
): InstallationRecord {
	mkdirSync(directory, { recursive: true });
	const raw = readInstallation(directory);
	if (InstallationIdFile.check(raw)) return { id: raw.id };

	const target = join(directory, "installation.json");
	const temp = join(directory, `.installation.json.${process.pid}.${randomUUID()}.tmp`);
	const record: InstallationRecord = { id: randomUUID() };
	try {
		writeFileSync(temp, `${JSON.stringify(record, null, "\t")}\n`, { flag: "wx" });
		try {
			publish(temp, target);
			return record;
		} catch (error) {
			if (!hasErrorCode(error, "EEXIST")) throw error;
			const winner = readInstallation(directory);
			if (InstallationIdFile.check(winner)) return { id: winner.id };
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
	if (AppInstalledFile.check(readInstallation(directory))) return false;
	const { id } = ensureInstallationIn(directory);
	const claim = join(directory, ".installation-app-installed.claim");
	try {
		writeFileSync(claim, "", { flag: "wx" });
	} catch (error) {
		if (hasErrorCode(error, "EEXIST")) return false;
		throw error;
	}

	const target = join(directory, "installation.json");
	const temp = join(directory, `.installation.json.${process.pid}.${randomUUID()}.tmp`);
	try {
		writeFileSync(temp, `${JSON.stringify({ id, appInstalled: true }, null, "\t")}\n`, {
			flag: "wx",
		});
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
