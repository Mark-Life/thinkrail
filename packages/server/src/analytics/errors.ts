import { dirname, isAbsolute, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

export type ErrorSource = "host_crash" | "host_logged" | "request" | "ui" | "desktop";
export type FatalErrorKind = "uncaughtException" | "unhandledRejection";

export const EXTERNAL_FRAME = "<external>";
const MAX_EXCEPTIONS = 5;
const MAX_FRAMES = 60;

export interface FrameRoots {
	appRoot: string;
	remapBase?: string;
	caseInsensitive: boolean;
}

export interface FrameRootOptions {
	appRoot?: string;
	remapBase?: string;
}

function safely<T>(read: () => T, fallback: T): T {
	try {
		return read();
	} catch {
		return fallback;
	}
}

function toSlashes(path: string): string {
	return path.replace(/\\/g, "/");
}

function stripTrailingSlash(path: string): string {
	return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

export function detectAppRoot(moduleUrl: string = import.meta.url): string {
	const moduleDir = toSlashes(dirname(fileURLToPath(moduleUrl)));
	const sourceSuffix = "/packages/server/src/analytics";
	return moduleDir.endsWith(sourceSuffix) ? moduleDir.slice(0, -sourceSuffix.length) : moduleDir;
}

export function frameRoots(options: FrameRootOptions = {}): FrameRoots {
	return {
		appRoot: stripTrailingSlash(
			toSlashes(options.appRoot ? resolve(options.appRoot) : detectAppRoot()),
		),
		...(options.remapBase ? { remapBase: options.remapBase } : {}),
		caseInsensitive: process.platform === "win32",
	};
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface NormalizedFrameFile {
	filename: string;
	inApp: boolean;
	web: boolean;
}

export function normalizeFrameFilename(
	filename: string | undefined,
	roots: FrameRoots,
): NormalizedFrameFile {
	const external = { filename: EXTERNAL_FRAME, inApp: false, web: false };
	if (!filename) return external;
	if (/^node:[a-z_/]+$/i.test(filename) || filename === "native") {
		return { filename, inApp: false, web: false };
	}
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(filename) && !/^file:\/\//i.test(filename)) {
		try {
			const url = new URL(filename);
			const local =
				url.protocol === "views:" ||
				((url.protocol === "http:" || url.protocol === "https:") && LOCAL_HOSTS.has(url.hostname));
			if (!local) return { ...external, web: true };
			const views = url.protocol === "views:";
			const clean = `${views ? url.host : ""}${url.pathname}`.replace(/^\/+/, "");
			if (!/^[A-Za-z0-9_\-./@]+$/.test(clean)) return { ...external, web: true };
			return { filename: `${views ? "views" : "web"}/${clean}`, inApp: true, web: true };
		} catch {
			return external;
		}
	}
	const raw = filename.startsWith("file://") ? safely(() => fileURLToPath(filename), "") : filename;
	if (!raw) return external;
	if (!isAbsolute(raw) && !/^[A-Za-z]:[\\/]/.test(raw)) return remappedFrame(raw, roots);
	const absolute = toSlashes(raw);
	const root = `${stripTrailingSlash(toSlashes(roots.appRoot))}/`;
	const within = roots.caseInsensitive
		? absolute.toLowerCase().startsWith(root.toLowerCase())
		: absolute.startsWith(root);
	if (root.length <= 1 || !within) return external;
	const relative = absolute.slice(root.length);
	if (!relative || !/^[A-Za-z0-9_\-./@$~+]+$/.test(relative)) return external;
	return { filename: relative, inApp: !relative.includes("node_modules/"), web: false };
}

function remappedFrame(raw: string, roots: FrameRoots): NormalizedFrameFile {
	const external = { filename: EXTERNAL_FRAME, inApp: false, web: false };
	if (!roots.remapBase) return external;
	const relative = posix.normalize(posix.join(roots.remapBase, toSlashes(raw)));
	if (relative.startsWith("../") || relative.startsWith("/") || relative === "..") return external;
	if (!/^[A-Za-z0-9_\-./@$~+]+\.[cm]?[jt]sx?$/.test(relative)) return external;
	return { filename: relative, inApp: !relative.includes("node_modules/"), web: false };
}

const CHUNK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CHUNK_IDS_PROPERTY = "$thinkrail_chunk_ids";

const SAFE_TYPE = /^[A-Za-z_$][A-Za-z0-9_$.]{0,63}$/;
const SAFE_FUNCTION = /^[A-Za-z0-9_$.<>[\]? -]{1,128}$/;
const SAFE_VALUE = /^[A-Za-z0-9_.:+-]{1,64}$/;
const MECHANISM_TYPES = new Set([
	"generic",
	"onunhandledrejection",
	"onuncaughtexception",
	"onconsole",
	"middleware",
]);
const CRASH_MECHANISMS = new Map<string, string>([
	["uncaughtException", "onuncaughtexception"],
	["unhandledRejection", "onunhandledrejection"],
]);
const LEVELS = new Set(["fatal", "error", "warning", "log", "info", "debug"]);
const PASSTHROUGH_KEYS = [
	"app_version",
	"channel",
	"os",
	"arch",
	"build",
	"source",
	"code",
	"scope",
	"request_method",
] as const;

const FrameSchema = Type.Object({
	filename: Type.Optional(Type.String()),
	function: Type.Optional(Type.String()),
	lineno: Type.Optional(Type.Number()),
	colno: Type.Optional(Type.Number()),
	chunk_id: Type.Optional(Type.String()),
});

const ExceptionSchema = Type.Object({
	type: Type.Optional(Type.String()),
	mechanism: Type.Optional(
		Type.Object({
			handled: Type.Optional(Type.Boolean()),
			synthetic: Type.Optional(Type.Boolean()),
			type: Type.Optional(Type.String()),
		}),
	),
	stacktrace: Type.Optional(Type.Object({ frames: Type.Array(Type.Unknown()) })),
});

const ExceptionListSchema = Type.Array(Type.Unknown());
const ChunkIdsSchema = Type.Record(Type.String(), Type.String());
const LevelSchema = Type.String();
const PassthroughValueSchema = Type.String({ pattern: SAFE_VALUE.source });

type Frame = Static<typeof FrameSchema>;
type Exception = Static<typeof ExceptionSchema>;
type ChunkIds = Static<typeof ChunkIdsSchema>;
type Passthrough = Partial<Record<(typeof PASSTHROUGH_KEYS)[number], string>>;

function positiveInt(value: number | undefined): number | undefined {
	return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

function frameChunkId(frame: Frame, chunkIds: ChunkIds): string | undefined {
	const own = frame.chunk_id;
	if (own !== undefined && CHUNK_ID.test(own)) return own;
	const mapped = frame.filename === undefined ? undefined : chunkIds[frame.filename];
	return mapped !== undefined && CHUNK_ID.test(mapped) ? mapped : undefined;
}

function sanitizeFrame(frame: unknown, roots: FrameRoots, chunkIds: ChunkIds) {
	if (!Check(FrameSchema, frame)) return null;
	const file = normalizeFrameFilename(frame.filename, roots);
	const external = file.filename === EXTERNAL_FRAME;
	const fn = frame.function ?? "";
	const base = {
		platform: file.web ? "web:javascript" : "node:javascript",
		filename: file.filename,
		function: !external && SAFE_FUNCTION.test(fn) ? fn : "?",
		in_app: file.inApp,
	};
	if (external) return base;
	const lineno = positiveInt(frame.lineno);
	const colno = positiveInt(frame.colno);
	const chunkId = frameChunkId(frame, chunkIds);
	return {
		...base,
		...(lineno !== undefined ? { lineno } : {}),
		...(colno !== undefined ? { colno } : {}),
		...(chunkId ? { chunk_id: chunkId } : {}),
	};
}

function sanitizeException(
	exception: Exception,
	value: string,
	roots: FrameRoots,
	chunkIds: ChunkIds,
) {
	const { mechanism, stacktrace } = exception;
	return {
		type: exception.type !== undefined && SAFE_TYPE.test(exception.type) ? exception.type : "Error",
		value,
		...(mechanism
			? {
					mechanism: {
						handled: mechanism.handled === true,
						synthetic: mechanism.synthetic === true,
						type:
							mechanism.type !== undefined && MECHANISM_TYPES.has(mechanism.type)
								? mechanism.type
								: "generic",
					},
				}
			: {}),
		...(stacktrace
			? {
					stacktrace: {
						type: "raw",
						frames: stacktrace.frames
							.slice(-MAX_FRAMES)
							.map((frame) => sanitizeFrame(frame, roots, chunkIds))
							.filter((frame) => frame !== null),
					},
				}
			: {}),
	};
}

function classifier(passthrough: Passthrough): string {
	return [passthrough.source, passthrough.request_method ?? passthrough.scope, passthrough.code]
		.filter((part) => part !== undefined)
		.join(" ");
}

export function sanitizeExceptionProperties(
	properties: Record<string, unknown>,
	roots: FrameRoots,
): Record<string, unknown> {
	const passthrough: Passthrough = {};
	for (const key of PASSTHROUGH_KEYS) {
		const value = properties[key];
		if (Check(PassthroughValueSchema, value)) passthrough[key] = value;
	}
	const listValue = properties.$exception_list;
	const list = Check(ExceptionListSchema, listValue) ? listValue : [];
	const chunkIdsValue = properties[CHUNK_IDS_PROPERTY];
	const chunkIds = Check(ChunkIdsSchema, chunkIdsValue) ? chunkIdsValue : {};
	const handled = typeof properties.handled === "boolean" ? properties.handled : undefined;
	const summary = classifier(passthrough);
	const crashType =
		passthrough.source === "host_crash" && passthrough.scope !== undefined
			? CRASH_MECHANISMS.get(passthrough.scope)
			: undefined;
	const exceptions = list
		.filter((exception) => Check(ExceptionSchema, exception))
		.slice(0, MAX_EXCEPTIONS)
		.map((exception, index) =>
			sanitizeException(exception, index === 0 ? summary : "", roots, chunkIds),
		)
		.map((exception, index) =>
			index === 0 && (handled !== undefined || crashType)
				? {
						...exception,
						mechanism: {
							synthetic: false,
							type: "generic",
							...exception.mechanism,
							...(handled !== undefined ? { handled } : {}),
							...(crashType ? { type: crashType } : {}),
						},
					}
				: exception,
		);
	const out: Record<string, unknown> = {
		$exception_list: exceptions,
		$process_person_profile: false,
	};
	const level = properties.$exception_level;
	if (Check(LevelSchema, level) && LEVELS.has(level)) out.$exception_level = level;
	if (handled !== undefined) out.handled = handled;
	return { ...out, ...passthrough };
}

export function createExceptionSanitizer(
	options: FrameRootOptions = {},
): (properties: Record<string, unknown>) => Record<string, unknown> {
	const roots = frameRoots(options);
	return (properties) => sanitizeExceptionProperties(properties, roots);
}

const MAX_CAUSE_DEPTH = 4;

export function messageFreeStack(stack: string | undefined, message: string): string | undefined {
	if (!stack) return undefined;
	if (!message) return stack;
	const at = stack.indexOf(message);
	return at < 0 ? undefined : `${stack.slice(0, at)}${stack.slice(at + message.length)}`;
}

export function reportableError(error: unknown, depth = 0): Error {
	const out = new Error();
	out.stack = "";
	if (!(error instanceof Error)) return out;
	out.name = error.name;
	out.stack = messageFreeStack(error.stack, error.message) ?? "";
	if (error.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
		out.cause = reportableError(error.cause, depth + 1);
	}
	return out;
}

const ErrorCodeSchema = Type.Object({ code: Type.String({ pattern: "^[A-Z][A-Z0-9_]{1,63}$" }) });

export function errorCode(error: unknown): string | undefined {
	return Check(ErrorCodeSchema, error) ? error.code : undefined;
}

export function toV8Stack(stack: string): string {
	return stack
		.split("\n")
		.map((line) => {
			const match = /^\s*(.*?)@(.+):(\d+):(\d+)\s*$/.exec(line);
			if (!match) return line;
			const [, fn, file, lineno, colno] = match;
			return `    at ${fn || "?"} (${file}:${lineno}:${colno})`;
		})
		.join("\n");
}
