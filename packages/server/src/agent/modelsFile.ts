import {
	accessSync,
	constants,
	mkdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	type Stats,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { CodedError } from "@thinkrail/shared/codedError";
import { hasErrno } from "@thinkrail/shared/errnoCode";
import { type Node, type ParseError, parseTree } from "jsonc-parser";

export const MODELS_JSON_PARSE = { allowTrailingComma: true };
export const MODELS_JSON_FORMATTING = {
	formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
};
const EMPTY_MODELS_JSON = '{\n  "providers": {}\n}\n';
const SAVE_FAILURE =
	"Couldn't save pi's models.json. Check the file and its permissions, then retry.";

let publishChange: (() => void) | null = null;

export function setModelsFilePublisher(publisher: (() => void) | null): void {
	publishChange = publisher;
}

export function publishModelsFileChange(): void {
	publishChange?.();
}

export function modelsPath(): string {
	return join(getAgentDir(), "models.json");
}

export function readModelsSource(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if (hasErrno(error, "ENOENT")) return undefined;
		throw new CodedError(
			"STATE_FILE_UNREADABLE",
			"Couldn't read pi's models.json. Fix the file and retry.",
			{ cause: error },
		);
	}
}

export function parseModelsConfig(source: string | undefined): Node | undefined {
	if (source === undefined) return undefined;
	const errors: ParseError[] = [];
	const root = parseTree(source.replace(/^\uFEFF/, ""), errors, MODELS_JSON_PARSE);
	if (errors.length > 0)
		throw new CodedError(
			"PI_MODELS_FILE_DAMAGED",
			"Pi's models.json isn't valid JSON. Fix the file and retry.",
		);
	return root;
}

export function splitModelsSource(source: string | undefined): { bom: string; body: string } {
	if (source === undefined) return { bom: "", body: EMPTY_MODELS_JSON };
	const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
	return { bom, body: source.slice(bom.length) };
}

function resolveModelsFile(path: string): string {
	try {
		return realpathSync(path);
	} catch (error) {
		if (!hasErrno(error, "ENOENT")) saveFailed(error);
	}
	const seen = new Set<string>();
	let current = path;
	while (!seen.has(current)) {
		seen.add(current);
		try {
			current = resolve(dirname(current), readlinkSync(current));
		} catch {
			return current;
		}
	}
	return saveFailed(new Error("models.json is a symlink loop"));
}

function saveFailed(cause: unknown): never {
	throw new CodedError("STATE_FILE_WRITE_FAILED", SAVE_FAILURE, { cause });
}

export function writeModelsFile(path: string, source: string): void {
	const target = resolveModelsFile(path);
	let existing: Stats | undefined;
	try {
		existing = statSync(target);
	} catch {
		mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
	}
	const temp = join(dirname(target), `.models.json.${process.pid}.tmp`);
	try {
		if (existing) accessSync(target, constants.W_OK);
		writeFileSync(temp, source, { mode: existing ? existing.mode & 0o777 : 0o600 });
		renameSync(temp, target);
	} catch (error) {
		rmSync(temp, { force: true });
		saveFailed(error);
	}
}

let writes: Promise<unknown> = Promise.resolve();

export function serializeModelsWrite<T>(run: () => Promise<T>): Promise<T> {
	const next = writes.catch(() => undefined).then(run);
	writes = next;
	return next;
}
