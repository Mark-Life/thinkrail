import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

const TextSchema = Type.String();
const FlagSchema = Type.Boolean();
const InstallMetaSchema = Type.Object({
	channel: Type.Optional(TextSchema),
	version: Type.Optional(TextSchema),
	tag: Type.Optional(TextSchema),
	prefix: Type.Optional(TextSchema),
	path_entry_added: Type.Optional(FlagSchema),
});
const InstallMetaFileSchema = Type.Object({
	channel: Type.Optional(Type.Unknown()),
	version: Type.Optional(Type.Unknown()),
	tag: Type.Optional(Type.Unknown()),
	prefix: Type.Optional(Type.Unknown()),
	path_entry_added: Type.Optional(Type.Unknown()),
});

export type InstallMeta = Static<typeof InstallMetaSchema>;

export function normalizeWindowsInstallPrefix(value: string | undefined): string | undefined {
	if (value === undefined || value.length === 0) return undefined;
	let prefix = value.replace(/\\/g, "/");
	const cygdrive = prefix.match(/^\/cygdrive\/([A-Za-z])(?:\/(.*))?$/);
	if (cygdrive) {
		prefix = `${cygdrive[1]?.toUpperCase()}:/${cygdrive[2] ?? ""}`;
	} else {
		const gitBash = prefix.match(/^\/([A-Za-z])(?:\/(.*))?$/);
		if (gitBash) prefix = `${gitBash[1]?.toUpperCase()}:/${gitBash[2] ?? ""}`;
	}
	if (!/^(?:[A-Za-z]:\/|\/\/[^/]+\/[^/]+(?:\/|$))/.test(prefix)) return undefined;
	const normalized = win32.normalize(prefix).replace(/\\/g, "/");
	return /^[A-Za-z]:/.test(normalized)
		? `${normalized[0]?.toUpperCase()}${normalized.slice(1)}`
		: normalized;
}

export function sameWindowsPath(a: string, b: string): boolean {
	const normalized = (value: string) =>
		win32.normalize(value).replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
	return normalized(a) === normalized(b);
}

export function installConfigDir(home: string): string {
	return join(home, ".config", "thinkrail");
}

export function installMetaFile(home: string): string {
	return join(installConfigDir(home), "install.json");
}

export function readInstallMeta(home: string): InstallMeta {
	try {
		const parsed: unknown = JSON.parse(readFileSync(installMetaFile(home), "utf8"));
		if (!Check(InstallMetaFileSchema, parsed)) return {};
		const { channel, version, tag, prefix, path_entry_added } = parsed;
		const meta: InstallMeta = {};
		if (Check(TextSchema, channel)) meta.channel = channel;
		if (Check(TextSchema, version)) meta.version = version;
		if (Check(TextSchema, tag)) meta.tag = tag;
		if (Check(TextSchema, prefix)) meta.prefix = prefix;
		if (Check(FlagSchema, path_entry_added)) meta.path_entry_added = path_entry_added;
		return meta;
	} catch {
		return {};
	}
}

function cacheRoot(): string {
	const xdg = process.env.XDG_CACHE_HOME;
	if (xdg) return xdg;
	const home = homedir();
	return home ? join(home, ".cache") : tmpdir();
}

export function stagingRoot(): string {
	return join(cacheRoot(), "thinkrail");
}
