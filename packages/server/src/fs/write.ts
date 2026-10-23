import {
	accessSync,
	constants,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
	FILE_WRITE_MAX_BYTES,
	type FileWriteResult,
	toEditorText,
	type WsParams,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import { decodeText, resourceMeta } from "./content";
import { errnoCode, statOrNull } from "./errno";
import { resolveWorktreeFile } from "./files";
import { replaceFile } from "./replace";
import { applyForm, textForm } from "./textForm";

type WriteTextFileParams = WsParams<"fs.writeFile">;

interface WriteTextFileOutcome {
	result: FileWriteResult;
	changed: boolean;
}

const BYTES = new TextEncoder();
const LFS_MIME = "application/vnd.git-lfs";
const READONLY_CODES = new Set(["EACCES", "EPERM", "EROFS"]);

function assertParams(params: WriteTextFileParams): void {
	if (typeof params.content !== "string") throw new Error("fs.writeFile content must be a string");
	const hash: unknown = params.expect?.hash;
	if (typeof hash !== "string" && hash !== null) {
		throw new Error("fs.writeFile expect.hash must be a string or null");
	}
}

function written(bytes: Uint8Array, path: string): WriteTextFileOutcome {
	return { result: { status: "written", meta: resourceMeta(bytes, path) }, changed: true };
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
		replaceFile(target, out, stat.mode & 0o777, { stat, bytes: current });
	} catch (error) {
		if (READONLY_CODES.has(String(errnoCode(error)))) {
			return { result: { status: "readonly" }, changed: false };
		}
		throw error;
	}
	return written(out, path);
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
