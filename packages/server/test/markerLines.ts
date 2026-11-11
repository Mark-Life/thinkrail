import { existsSync, readFileSync } from "node:fs";
import type { Validator } from "@earendil-works/pi-schema";

/** The complete JSON lines appended to `path`, each checked by `line`; a partly written last line waits. */
export function readMarkerLines<T>(path: string, line: Validator<T>): T[] {
	if (!existsSync(path)) return [];
	const lines = readFileSync(path, "utf8").split("\n");
	lines.pop();
	return lines.map((text) => {
		const value: unknown = JSON.parse(text);
		if (!line.check(value)) throw new Error(`unexpected marker line: ${text}`);
		return value;
	});
}
