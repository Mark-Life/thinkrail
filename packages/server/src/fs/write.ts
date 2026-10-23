import { randomBytes } from "node:crypto";
import {
	accessSync,
	chmodSync,
	constants,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	type Stats,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	FILE_WRITE_MAX_BYTES,
	type FileWriteResult,
	toEditorText,
	type WsParams,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import { decodeText, resourceMeta } from "./content";
import { resolveWorktreeFile } from "./files";
import { applyForm, textForm } from "./textForm";

export type WriteTextFileParams = WsParams<"fs.writeFile">;

export interface WriteTextFileOutcome {
	result: FileWriteResult;
	changed: boolean;
}

type WriteStrategy = "atomic" | "inPlace";

const BYTES = new TextEncoder();
const LFS_MIME = "application/vnd.git-lfs";
const READONLY_CODES = new Set(["EACCES", "EPERM", "EROFS"]);
const IN_PLACE_FALLBACK_CODES = new Set(["EACCES", "EPERM", "EBUSY", "EXDEV"]);

function errnoCode(error: unknown): unknown {
	return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function isMissing(error: unknown): boolean {
	const code = errnoCode(error);
	return code === "ENOENT" || code === "ENOTDIR";
}

function statOrNull(abs: string, follow: boolean): Stats | null {
	try {
		return follow ? statSync(abs) : lstatSync(abs);
	} catch (error) {
		if (isMissing(error)) return null;
		throw error;
	}
}

function assertParams(params: WriteTextFileParams): void {
	if (typeof params.content !== "string") throw new Error("fs.writeFile content must be a string");
	const hash: unknown = params.expect?.hash;
	if (typeof hash !== "string" && hash !== null) {
		throw new Error("fs.writeFile expect.hash must be a string or null");
	}
}

export function writeStrategy(
	stat: Pick<Stats, "nlink" | "uid">,
	uid: number | undefined,
): WriteStrategy {
	return stat.nlink > 1 || (uid !== undefined && stat.uid !== uid) ? "inPlace" : "atomic";
}

function written(bytes: Uint8Array, path: string): WriteTextFileOutcome {
	return { result: { status: "written", meta: resourceMeta(bytes, path) }, changed: true };
}

function writeInPlace(target: string, out: Uint8Array, path: string): WriteTextFileOutcome {
	try {
		writeFileSync(target, out);
	} catch (error) {
		if (READONLY_CODES.has(String(errnoCode(error)))) {
			return { result: { status: "readonly" }, changed: false };
		}
		throw error;
	}
	return written(out, path);
}

function writeAtomic(
	target: string,
	out: Uint8Array,
	mode: number,
	path: string,
): WriteTextFileOutcome {
	const tmp = join(
		dirname(target),
		`.thinkrail-write-${process.pid}-${randomBytes(4).toString("hex")}.tmp`,
	);
	try {
		writeFileSync(tmp, out, { flag: "wx" });
		chmodSync(tmp, mode);
		renameSync(tmp, target);
		return written(out, path);
	} catch (error) {
		rmSync(tmp, { force: true });
		if (!IN_PLACE_FALLBACK_CODES.has(String(errnoCode(error)))) throw error;
	}
	return writeInPlace(target, out, path);
}

function createFile(
	abs: string,
	params: WriteTextFileParams,
	retried: boolean,
): WriteTextFileOutcome {
	if (statOrNull(abs, false) !== null) {
		throw new CodedError("NOT_EDITABLE", `${params.path} is a symbolic link to a missing file.`);
	}
	const bytes = BYTES.encode(params.content);
	mkdirSync(dirname(abs), { recursive: true });
	try {
		writeFileSync(abs, bytes, { flag: "wx" });
	} catch (error) {
		if (errnoCode(error) === "EEXIST" && !retried) return writePass(params, true);
		throw error;
	}
	return written(bytes, params.path);
}

function writePass(params: WriteTextFileParams, retried: boolean): WriteTextFileOutcome {
	const { workspaceId, path, content, expect } = params;
	const abs = resolveWorktreeFile(workspaceId, path);
	const stat = statOrNull(abs, true);
	if (stat === null) {
		if (expect.hash !== null) return { result: { status: "missing" }, changed: false };
		return createFile(abs, params, retried);
	}
	if (!stat.isFile()) throw new CodedError("NOT_EDITABLE", `${path} is not a regular file.`);

	const target = realpathSync(abs);
	const current = readFileSync(target);
	const meta = resourceMeta(current, path);
	const out = applyForm(toEditorText(content), textForm(current));
	if (current.equals(out)) return { result: { status: "written", meta }, changed: false };
	if (meta.hash !== expect.hash) {
		const text = meta.text ? decodeText(current) : "";
		return { result: { status: "stale", current: { content: text, meta } }, changed: false };
	}
	if (!meta.text || meta.mime === LFS_MIME) {
		throw new CodedError("NOT_EDITABLE", `${path} is not an editable text file.`);
	}
	try {
		accessSync(target, constants.W_OK);
	} catch (error) {
		if (READONLY_CODES.has(String(errnoCode(error)))) {
			return { result: { status: "readonly" }, changed: false };
		}
		throw error;
	}
	return writeStrategy(stat, process.getuid?.()) === "atomic"
		? writeAtomic(target, out, stat.mode & 0o777, path)
		: writeInPlace(target, out, path);
}

export function writeTextFile(params: WriteTextFileParams): WriteTextFileOutcome {
	assertParams(params);
	if (Buffer.byteLength(params.content, "utf8") > FILE_WRITE_MAX_BYTES) {
		throw new CodedError(
			"FILE_TOO_LARGE",
			`${params.path} is larger than the ${FILE_WRITE_MAX_BYTES}-byte write limit.`,
		);
	}
	return writePass(params, false);
}
