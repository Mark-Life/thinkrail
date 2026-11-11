import { parseProjectId, parseWorkspaceId, randomUuid } from "@thinkrail/contracts";
import { CodedError } from "./codedError";

function generated<T>(parse: (value: unknown) => T | null, kind: string) {
	const id = parse(randomUuid());
	if (id === null) throw new CodedError("HOST_ERROR", `generated ${kind} id is not a valid id`);
	return id;
}

export const newProjectId = () => generated(parseProjectId, "project");
export const newWorkspaceId = () => generated(parseWorkspaceId, "workspace");
