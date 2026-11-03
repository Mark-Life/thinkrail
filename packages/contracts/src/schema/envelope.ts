import {
	arr,
	bool,
	opt,
	type Schema,
	type Static,
	str,
	union,
	unknown,
} from "@earendil-works/pi-schema";
import { SessionId } from "./ids";
import { wireObj } from "./wire";

export type WsErrorCode =
	| "STATE_FILE_SET_ASIDE"
	| "STATE_FILE_UNREADABLE"
	| "UNKNOWN_COMMIT"
	| "PUSH_AUTH_FAILED"
	| "GH_REPLY_INVALID"
	| "NOT_GIT"
	| "ALREADY_OPEN"
	| "PROJECT_CLONE_INVALID"
	| "PROJECT_CLONE_FAILED"
	| "PROJECT_CLONE_CLEANUP_FAILED"
	| "SUBAGENT_TRANSCRIPT_NOT_FOUND"
	| "RESOURCE_UNAVAILABLE"
	| "STALE_VIEW"
	| "SCOPE_IMMUTABLE"
	| "RANGE_INVALID"
	| "RECEIPT_UNKNOWN"
	| "UNSUPPORTED_CHANGE"
	| "LOGIN_NOT_OWNER"
	| "MCP_CONFIG_INVALID"
	| "MCP_PATH_UNSAFE"
	| "MCP_HANDLED_ELSEWHERE"
	| "SURVEY_UNAVAILABLE"
	| "SURVEY_CHANGED"
	| "SURVEY_INVALID"
	| "SURVEY_NOT_SENT"
	| "PACKAGE_SOURCE_INVALID"
	| "PACKAGE_OFFLINE"
	| "PACKAGE_UNTRUSTED"
	| "PACKAGE_UNKNOWN"
	| "PACKAGE_INSTALL_FAILED"
	| "PACKAGE_INSTALLED_UNLISTED"
	| "PACKAGE_REMOVE_FAILED"
	| "PACKAGE_UPDATE_FAILED"
	| "PACKAGE_SETTINGS_WRITE_FAILED"
	| "REQUEST_REPLAY_OVERFLOW"
	| "INSTALLED_FONTS_UNAVAILABLE"
	| "INVALID_PARAMS"
	| "INVALID_REPLY"
	| "NATIVE_RPC_INVALID";

/** Any string passes: a newer host may send a code this client does not know. */
const WireErrorCode: Schema<WsErrorCode> = { type: "string" };

export const WsResponse = wireObj({
	id: str(),
	ok: bool(),
	result: opt(unknown()),
	error: opt(str()),
	errorCode: opt(WireErrorCode),
});
export type WsResponse = Static<typeof WsResponse>;

/** Any frame from the host. The payload of a push is checked by its channel, the result of a reply by its method. */
export const WsEnvelope = union([wireObj({ channel: str(), data: opt(unknown()) }), WsResponse]);
export type WsEnvelope = Static<typeof WsEnvelope>;

/** Any request from a client. `method` may be one this host does not know, and `params` is checked by its method. */
export const WsRequestFrame = wireObj({
	id: str(),
	method: str(),
	params: opt(unknown()),
	sessionId: opt(SessionId),
});
export type WsRequestFrame = Static<typeof WsRequestFrame>;

export const WsAck = wireObj({ ack: arr(str()) });
export type WsAck = Static<typeof WsAck>;

export const WsResume = wireObj({ resume: arr(str()) });
export type WsResume = Static<typeof WsResume>;
