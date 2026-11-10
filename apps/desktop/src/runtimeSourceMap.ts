import { createHash } from "node:crypto";
import { compile, lit, obj, opt, type Static, str } from "@earendil-works/pi-schema";

const SourceMapJson = obj(
	{ version: lit(3), mappings: str(), chunk_id: opt(str()) },
	{ open: true },
);
/**
 * A v3 source map, typed by the fields chunk-id injection reads. Other fields pass the open check
 * unread and `injectChunkId` copies them into the new map.
 */
export type SourceMapJson = Static<typeof SourceMapJson>;
const isSourceMapJson = compile(SourceMapJson).check;

/** The source map in `text`; throws when it is not one. */
export function parseSourceMap(text: string): SourceMapJson {
	const map: unknown = JSON.parse(text);
	if (!isSourceMapJson(map)) throw new Error("not a v3 source map with string `mappings`");
	return map;
}

export function chunkIdFor(code: string, map: SourceMapJson, release: string): string {
	const hex = createHash("sha256")
		.update(release)
		.update("\0")
		.update(code)
		.update("\0")
		.update(JSON.stringify(map))
		.digest("hex");
	const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function registration(chunkId: string): string {
	return `!function(){try{var e=globalThis,n=(new e.Error).stack;n&&(e._posthogChunkIds=e._posthogChunkIds||{},e._posthogChunkIds[n]=${JSON.stringify(chunkId)})}catch(e){}}();`;
}

export function injectChunkId(
	code: string,
	map: SourceMapJson,
	release: string,
): { code: string; map: SourceMapJson; chunkId: string } {
	const chunkId = chunkIdFor(code, map, release);
	const lines = code.split("\n");
	const at = lines[0]?.startsWith("// @bun") ? 1 : 0;
	lines.splice(at, 0, registration(chunkId));
	const groups = map.mappings.split(";");
	groups.splice(at, 0, "");
	const tail = code.endsWith("\n") ? "" : "\n";
	return {
		code: `${lines.join("\n")}${tail}//# chunkId=${chunkId}\n`,
		map: { ...map, mappings: groups.join(";"), chunk_id: chunkId },
		chunkId,
	};
}
