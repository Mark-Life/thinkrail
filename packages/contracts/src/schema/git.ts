import { num, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import { wireObj } from "./wire";

export const GitFileStatus = oneOf(["added", "modified", "deleted", "renamed", "untracked"]);
export type GitFileStatus = Static<typeof GitFileStatus>;

export const GitFileChange = wireObj({
	path: str(),
	status: GitFileStatus,
	added: opt(num()),
	removed: opt(num()),
});
export type GitFileChange = Static<typeof GitFileChange>;
