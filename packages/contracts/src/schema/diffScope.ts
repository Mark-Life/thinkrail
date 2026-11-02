import { lit, num, type Static, str, union } from "@earendil-works/pi-schema";
import { wireObj } from "./wire";

export const GitDiffScope = union([
	wireObj({ kind: lit("branch") }),
	wireObj({ kind: lit("uncommitted") }),
	wireObj({ kind: lit("commit"), sha: str() }),
	wireObj({ kind: lit("pinned"), baseRef: str() }),
	wireObj({
		kind: lit("turn"),
		id: str(),
		baseTree: str(),
		headTree: str(),
		startedAt: num(),
	}),
]);
export type GitDiffScope = Static<typeof GitDiffScope>;
