import { arr, lit, opt, type Static, str, union, unknown } from "@earendil-works/pi-schema";
import { SPEECH_ERROR_CODES } from "./speech";
import { wireObj } from "./wire";

export const WS_ERROR_CODES = [
	"STATE_FILE_SET_ASIDE",
	"STATE_FILE_UNREADABLE",
	"STATE_FILE_PRUNE_FAILED",
	"STATE_FILE_WRITE_FAILED",
	"UNKNOWN_COMMIT",
	"PUSH_AUTH_FAILED",
	"GH_REPLY_INVALID",
	"NOT_GIT",
	"ALREADY_OPEN",
	"PROJECT_CLONE_INVALID",
	"PROJECT_CLONE_FAILED",
	"PROJECT_CLONE_CLEANUP_FAILED",
	"SUBAGENT_TRANSCRIPT_NOT_FOUND",
	"PI_SESSION_FILE_DAMAGED",
	"SESSION_MODEL_UNAVAILABLE",
	"RESOURCE_UNAVAILABLE",
	"SESSION_UNKNOWN",
	"STALE_VIEW",
	"SCOPE_IMMUTABLE",
	"RANGE_INVALID",
	"RECEIPT_UNKNOWN",
	"UNSUPPORTED_CHANGE",
	"REVIEW_REANCHOR_FAILED",
	"LOGIN_NOT_OWNER",
	"ANALYTICS_CONSENT_REQUIRED",
	"THEME_PAIR_REQUIRED",
	"MCP_CONFIG_INVALID",
	"MCP_PATH_UNSAFE",
	"MCP_HANDLED_ELSEWHERE",
	"SURVEY_UNAVAILABLE",
	"SURVEY_CHANGED",
	"SURVEY_INVALID",
	"SURVEY_NOT_SENT",
	"PACKAGE_SOURCE_INVALID",
	"PACKAGE_OFFLINE",
	"PACKAGE_UNTRUSTED",
	"PACKAGE_UNKNOWN",
	"PACKAGE_INSTALL_FAILED",
	"PACKAGE_INSTALLED_UNLISTED",
	"PACKAGE_REMOVE_FAILED",
	"PACKAGE_UPDATE_FAILED",
	"PACKAGE_SETTINGS_WRITE_FAILED",
	"REQUEST_REPLAY_OVERFLOW",
	"INSTALLED_FONTS_UNAVAILABLE",
	"GIT_TIMEOUT",
	"WORKTREE_ADD_FAILED",
	"WORKTREE_CHECKOUT_FAILED",
	"WORKTREE_CHECKOUT_STALLED",
	"WORKSPACE_PATH_TAKEN",
	"FILE_TOO_LARGE",
	"TODO_COUNT_FAILED",
	"INVALID_PARAMS",
	"PI_SESSION_ID_INVALID",
	"INVALID_REPLY",
	"WS_RESULT_INVALID",
	"NATIVE_RPC_INVALID",
	"HOST_ERROR",
	"FONT_UPLOAD_FAILED",
	"WORKSPACE_UNKNOWN",
	"SESSION_RELOAD_FAILED",
	...SPEECH_ERROR_CODES,
] as const;
export type WsErrorCode = (typeof WS_ERROR_CODES)[number];

export const WsResponse = union([
	wireObj({ id: str(), ok: lit(true), result: opt(unknown()) }),
	wireObj({ id: str(), ok: lit(false), error: str(), errorCode: opt(str()) }),
]);
export type WsResponse = Static<typeof WsResponse>;

/** Any frame from the host. The payload of a push is checked by its channel, the result of a reply by its method. */
export const WsEnvelope = union([wireObj({ channel: str(), data: opt(unknown()) }), WsResponse]);
export type WsEnvelope = Static<typeof WsEnvelope>;

/** Any request from a client. `method` may be one this host does not know, and `params` is checked by its method. */
export const WsRequestFrame = wireObj({
	id: str(),
	method: str(),
	params: opt(unknown()),
	sessionId: opt(str()),
});
export type WsRequestFrame = Static<typeof WsRequestFrame>;

export const WsAck = wireObj({ ack: arr(str()) });
export type WsAck = Static<typeof WsAck>;

export const WsResume = wireObj({ resume: arr(str()) });
export type WsResume = Static<typeof WsResume>;
