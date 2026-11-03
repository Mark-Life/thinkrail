import {
	arr,
	bool,
	lit,
	map,
	num,
	oneOf,
	opt,
	type Static,
	str,
	union,
	unknown,
} from "@earendil-works/pi-schema";
import { SessionId, WorkspaceId } from "./ids";
import { Ack, wireObj } from "./wire";

export const McpActiveExposure = oneOf(["deferred", "direct", "hidden"]);

export const McpProjectOverride = wireObj({
	enabled: opt(bool()),
	exposure: opt(McpActiveExposure),
});
export type McpProjectOverride = Static<typeof McpProjectOverride>;

/** Tools (pi tool names) granted while the server keeps the command + args or URL hashed as `target`. */
export const McpToolGrant = wireObj({ target: str(), tools: arr(str()) });
export type McpToolGrant = Static<typeof McpToolGrant>;

export const McpTransportKind = oneOf(["stdio", "http"]);
export type McpTransportKind = Static<typeof McpTransportKind>;

export const McpServerState = oneOf([
	"starting",
	"connected",
	"needs-sign-in",
	"failed",
	"disconnected",
	"disabled",
	"disabled-in-project",
	"disabled-in-chat",
	"pending-approval",
	"invalid-config",
	"pending-reload",
	"not-running",
	"handled-elsewhere",
	"unknown",
]);
export type McpServerState = Static<typeof McpServerState>;

export const McpServerResourceSummary = wireObj({
	name: str(),
	state: McpServerState,
	toolCount: opt(num()),
	transport: McpTransportKind,
	/** Registered by an extension (`pi.registerMcpServer()`), not an `mcp.json` entry: it cannot be disabled per chat. */
	registered: opt(lit(true)),
});
export type McpServerResourceSummary = Static<typeof McpServerResourceSummary>;

export const McpServerScope = oneOf(["user", "project"]);
export type McpServerScope = Static<typeof McpServerScope>;

/** Configured exposure; `codemode` is accepted from files and treated as `deferred` while codemode is not shipped. */
export const McpExposure = oneOf(["deferred", "direct", "hidden", "codemode"]);
export type McpExposure = Static<typeof McpExposure>;

/** The session-independent view of one configured server; secret literal values are masked. */
export const McpServerSummary = wireObj({
	name: str(),
	scope: McpServerScope,
	/** Defining `mcp.json` path. */
	source: str(),
	/** Fingerprint of the defining file's entry as rendered; `mcp.update` / `mcp.remove` name their target with it. */
	fingerprint: str(),
	transport: McpTransportKind,
	/** Command + args, or URL, with literal credential values masked. */
	endpoint: str(),
	exposure: McpExposure,
	effectiveExposure: McpActiveExposure,
	effective: opt(bool()),
	enabled: bool(),
	description: opt(str()),
	/** HTTP server without an `Authorization` header: sign-in applies. */
	oauth: bool(),
	/** Project entry that shadows a user-level server of the same name. */
	replacesGlobal: opt(bool()),
	projectOverride: opt(McpProjectOverride),
	/** Repository content only: the project entry, or the repo override folded into a user row. */
	approval: opt(wireObj({ state: oneOf(["approved", "pending", "changed"]), fingerprint: str() })),
	/** pi-equivalent validation message when the entry is rejected; credential-looking values are masked by the host. */
	configError: opt(str()),
	/** Always-allowed tools still valid for the effective entry: pi's tool name and its display label. */
	alwaysAllowed: opt(arr(wireObj({ tool: str(), label: str() }))),
});
export type McpServerSummary = Static<typeof McpServerSummary>;

export const McpServerStatus = wireObj({
	name: str(),
	state: McpServerState,
	/** Server-reported count from pi's status text; absent when not connected. */
	toolCount: opt(num()),
	/**
	 * pi's status line(s) for this server. pi does not redact them (connection errors, a stdio server's
	 * stderr tail), so the host masks credential-looking values before they leave it.
	 */
	detail: opt(str()),
	updatedAt: num(),
});
export type McpServerStatus = Static<typeof McpServerStatus>;

export const McpStatusSnapshot = wireObj({
	workspaceId: WorkspaceId,
	sessionId: SessionId,
	/** Monotonic per session; a stale snapshot never overwrites a newer one. */
	generation: num(),
	servers: arr(McpServerStatus),
});
export type McpStatusSnapshot = Static<typeof McpStatusSnapshot>;

export const McpReadOutputResult = union([
	wireObj({ available: lit(true), text: str(), truncated: bool() }),
	wireObj({ available: lit(false), reason: oneOf(["expired", "unavailable"]) }),
]);
export type McpReadOutputResult = Static<typeof McpReadOutputResult>;

/** One server's lines from pi's shared MCP log (the messages servers send it), masked by the host. */
export const McpServerLog = wireObj({
	/** The file pi appends to: `mcp.log` in pi's agent directory. */
	path: str(),
	/** The server's latest lines, oldest first and at most 200; empty when it logged nothing there. */
	text: str(),
});
export type McpServerLog = Static<typeof McpServerLog>;

/** One raw `mcpServers` entry as written in a config file; validated by the host with pi-equivalent rules. */
export const McpServerEntryInput = map(unknown());
export type McpServerEntryInput = Static<typeof McpServerEntryInput>;

/** A problem with a whole `mcp.json` (unparsable JSON, `mcpServers` not an object, a mistyped top-level key), masked by the host. */
export const McpConfigFileError = wireObj({
	/** The file's path. */
	source: str(),
	message: str(),
});
export type McpConfigFileError = Static<typeof McpConfigFileError>;

export const McpListResult = wireObj({
	servers: arr(McpServerSummary),
	statuses: arr(McpStatusSnapshot),
	/** File-level problems of the files `servers` came from; absent when there are none or the host predates them. */
	configErrors: opt(arr(McpConfigFileError)),
	/** MCP is provided by a user-installed extension or disabled through pi settings; management is read-only. */
	handledElsewhere: opt(wireObj({ by: str() })),
});
export type McpListResult = Static<typeof McpListResult>;

const RENDERED_TARGET_FIELDS = {
	scope: McpServerScope,
	expectedFingerprint: str(),
};

/**
 * The entry a rewrite or removal was rendered from: its scope and the `McpServerSummary.fingerprint` the
 * client rendered it with. The host refuses the write when the entry on disk no longer has it.
 */
export const McpRenderedTarget = wireObj(RENDERED_TARGET_FIELDS);
export type McpRenderedTarget = Static<typeof McpRenderedTarget>;

const LoginStarted = wireObj({ loginId: str() });

export const MCP_METHODS = {
	"mcp.list": { params: wireObj({ workspaceId: WorkspaceId }), result: McpListResult },
	"mcp.add": {
		params: wireObj({
			workspaceId: WorkspaceId,
			scope: McpServerScope,
			name: str(),
			entry: McpServerEntryInput,
		}),
		result: McpListResult,
	},
	"mcp.update": {
		params: wireObj({
			workspaceId: WorkspaceId,
			name: str(),
			entry: McpServerEntryInput,
			...RENDERED_TARGET_FIELDS,
		}),
		result: McpListResult,
	},
	"mcp.remove": {
		params: wireObj({ workspaceId: WorkspaceId, name: str(), ...RENDERED_TARGET_FIELDS }),
		result: McpListResult,
	},
	"mcp.setProjectOverride": {
		params: wireObj({
			workspaceId: WorkspaceId,
			name: str(),
			enabled: opt(bool()),
			exposure: opt(McpActiveExposure),
		}),
		result: McpListResult,
	},
	"mcp.setSessionOverride": {
		params: wireObj({
			workspaceId: WorkspaceId,
			sessionId: SessionId,
			name: str(),
			enabled: bool(),
		}),
		result: Ack,
	},
	"mcp.approve": {
		params: wireObj({ workspaceId: WorkspaceId, name: str(), fingerprint: str() }),
		result: McpListResult,
	},
	"mcp.revokeToolGrant": {
		params: wireObj({ workspaceId: WorkspaceId, name: str(), tool: str() }),
		result: McpListResult,
	},
	"mcp.shareWithRepo": {
		params: wireObj({ workspaceId: WorkspaceId, name: str() }),
		result: McpListResult,
	},
	"mcp.login": { params: wireObj({ workspaceId: WorkspaceId, name: str() }), result: LoginStarted },
	"mcp.logout": { params: wireObj({ workspaceId: WorkspaceId, name: str() }), result: Ack },
	"mcp.testConnection": {
		params: wireObj({ workspaceId: WorkspaceId, name: str() }),
		result: LoginStarted,
	},
	"mcp.reconnect": {
		params: wireObj({ workspaceId: WorkspaceId, sessionId: SessionId, name: str() }),
		result: Ack,
	},
	"mcp.readOutput": {
		params: wireObj({ workspaceId: WorkspaceId, sessionId: SessionId, toolCallId: str() }),
		result: McpReadOutputResult,
	},
	"mcp.readLog": {
		params: wireObj({ workspaceId: WorkspaceId, name: str() }),
		result: McpServerLog,
	},
};

export const MCP_CHANNELS = {
	"mcp.status": McpStatusSnapshot,
};
