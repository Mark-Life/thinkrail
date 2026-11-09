import {
	arr,
	bool,
	lit,
	num,
	oneOf,
	opt,
	type Static,
	str,
	union,
} from "@earendil-works/pi-schema";
import {
	ProjectId,
	SessionId,
	StoredProjectId,
	StoredSessionId,
	StoredWorkspaceId,
	WorkspaceId,
} from "./ids";
import { wireObj } from "./wire";

export const HistoryScope = union([
	wireObj({ kind: lit("chat"), sessionId: SessionId }),
	wireObj({ kind: lit("workspace"), workspaceId: WorkspaceId }),
	wireObj({ kind: lit("project"), projectId: ProjectId }),
	wireObj({ kind: lit("all") }),
]);
export type HistoryScope = Static<typeof HistoryScope>;

const PROMPT_HIT_FIELDS = {
	text: str(),
	timestamp: num(),
	sessionId: StoredSessionId,
	sessionTitle: opt(str()),
	workspaceId: opt(StoredWorkspaceId),
	projectId: opt(StoredProjectId),
	cwd: str(),
	messageIndex: opt(num()),
	anchorText: opt(str()),
};

export const PromptHit = wireObj(PROMPT_HIT_FIELDS);
export type PromptHit = Static<typeof PromptHit>;

export const MessageHit = wireObj({
	...PROMPT_HIT_FIELDS,
	role: oneOf(["user", "assistant"]),
	snippet: str(),
	messageIndex: num(),
	anchorText: str(),
});
export type MessageHit = Static<typeof MessageHit>;

export const HistorySearchResult = wireObj({
	prompts: arr(PromptHit),
	messages: arr(MessageHit),
	promptTotal: num(),
	messageTotal: num(),
	indexing: bool(),
});
export type HistorySearchResult = Static<typeof HistorySearchResult>;

export const HISTORY_METHODS = {
	"history.search": {
		params: wireObj({ query: str(), scope: HistoryScope, limit: opt(num()) }),
		result: HistorySearchResult,
	},
};
