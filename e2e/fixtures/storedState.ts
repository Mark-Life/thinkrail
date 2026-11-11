import { readFileSync } from "node:fs";
import { join } from "node:path";
import { arr, compile, type Validator } from "@earendil-works/pi-schema";
import { Project, Workspace } from "@thinkrail/contracts";
import { hasErrno } from "@thinkrail/shared/errnoCode";
import { E2E_DATA_DIR } from "./paths";

const ProjectList = compile(arr(Project));
const WorkspaceList = compile(arr(Workspace));

function readList<T>(path: string, list: Validator<T[]>): T[] {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (hasErrno(error, "ENOENT")) return [];
		throw error;
	}
	const value: unknown = JSON.parse(text);
	if (!list.check(value)) throw new Error(`${path} holds entries its schema refuses`);
	return value;
}

/** The projects the host persisted; none when it has not written the file yet. */
export function readPersistedProjects(dataDir = E2E_DATA_DIR) {
	return readList(join(dataDir, "projects.json"), ProjectList);
}

/** The workspaces the host persisted; none when it has not written the file yet. */
export function readPersistedWorkspaces(dataDir = E2E_DATA_DIR) {
	return readList(join(dataDir, "workspaces.json"), WorkspaceList);
}
