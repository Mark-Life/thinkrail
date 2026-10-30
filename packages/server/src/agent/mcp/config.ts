import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	LoadedMcpConfig,
	McpExposure,
	McpServerConfig,
	McpServerEntry,
} from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { McpProjectOverride, McpToolGrant, Project } from "@thinkrail/contracts";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

// Port of pi's `core/mcp-servers.ts` and `extensions/mcp/config.ts` (MIT, Earendil Works).

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
export const McpExposureSchema = Type.Union([
	Type.Literal("codemode"),
	Type.Literal("deferred"),
	Type.Literal("direct"),
	Type.Literal("hidden"),
]);
const MCP_EXPOSURES = McpExposureSchema.anyOf.map((entry) => entry.const);
const MCP_EXPOSURE_ALIASES: Readonly<Record<string, McpExposure>> = {
	"codemode-deferred": "codemode",
};
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"] as const;

export type McpConfigScope = "global" | "project";

export function globalMcpConfigPath(agentDir: string): string {
	return join(agentDir, "mcp.json");
}

export function projectMcpConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "mcp.json");
}

export function mcpNamespace(server: string): string {
	return `mcp__${server.replace(/-/g, "_")}`;
}

const McpJsonSchema = Type.Cyclic(
	{
		Json: Type.Union([
			Type.Null(),
			Type.Boolean(),
			Type.Number(),
			Type.String(),
			Type.Array(Type.Ref("Json")),
			Type.Record(Type.String(), Type.Ref("Json")),
		]),
	},
	"Json",
);
export type McpJson = Static<typeof McpJsonSchema>;

export const McpJsonObjectSchema = Type.Record(Type.String(), McpJsonSchema);
export type McpJsonObject = Static<typeof McpJsonObjectSchema>;

export const McpFileSchema = Type.Object({
	mcpServers: Type.Optional(McpJsonObjectSchema),
	autoEnableCodemode: Type.Optional(McpJsonSchema),
});
export type McpFile = Static<typeof McpFileSchema>;

const StringSchema = Type.String();
const BooleanSchema = Type.Boolean();
const NonBlankStringSchema = Type.String({ pattern: "\\S" });
const StringMapSchema = Type.Record(Type.String(), Type.String());
const ToolExposureSchema = Type.Record(Type.String(), McpExposureSchema);
const AuthSchema = Type.Object({ provider: Type.String({ minLength: 1 }) });
const ArgsSchema = Type.Array(StringSchema);
const TimeoutSchema = Type.Number({ exclusiveMinimum: 0 });
const PortSchema = Type.Integer({ minimum: 1, maximum: 65535 });
const ClientRegistrationSchema = Type.Union([Type.Literal("dcr"), Type.Literal("cimd")]);

const OAuthSchema = Type.Object({
	clientId: Type.Optional(StringSchema),
	clientSecret: Type.Optional(StringSchema),
	callbackPort: Type.Optional(PortSchema),
	callbackUrl: Type.Optional(StringSchema),
	scope: Type.Optional(StringSchema),
	clientName: Type.Optional(NonBlankStringSchema),
	clientRegistration: Type.Optional(ClientRegistrationSchema),
	authServerMetadataUrl: Type.Optional(StringSchema),
});

const CommonFields = {
	exposure: Type.Optional(McpExposureSchema),
	toolExposure: Type.Optional(ToolExposureSchema),
	description: Type.Optional(StringSchema),
	enabled: Type.Optional(BooleanSchema),
	timeout: Type.Optional(TimeoutSchema),
};

const HttpServerSchema = Type.Object({
	...CommonFields,
	type: Type.Optional(Type.Literal("http")),
	url: StringSchema,
	headers: Type.Optional(StringMapSchema),
	oauth: Type.Optional(OAuthSchema),
	auth: Type.Optional(AuthSchema),
});

const StdioServerSchema = Type.Object({
	...CommonFields,
	type: Type.Optional(Type.Literal("stdio")),
	command: StringSchema,
	args: Type.Optional(ArgsSchema),
	env: Type.Optional(StringMapSchema),
	cwd: Type.Optional(StringSchema),
});

const OverrideSchema = Type.Object({
	enabled: CommonFields.enabled,
	exposure: CommonFields.exposure,
	toolExposure: CommonFields.toolExposure,
});

export function isOverrideEntry(value: McpJsonObject): boolean {
	return value.command === undefined && value.url === undefined && value.type === undefined;
}

export function isLoopbackRedirectUri(value: string): boolean {
	if (!URL.canParse(value)) return false;
	const url = new URL(value);
	return (
		url.protocol === "http:" &&
		LOOPBACK_HOSTS.includes(url.hostname) &&
		url.search === "" &&
		url.hash === ""
	);
}

function validateOAuth(value: McpJson | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (!Check(McpJsonObjectSchema, value)) return "oauth must be an object";
	const { clientId, clientSecret, callbackUrl, scope, clientName, clientRegistration } = value;
	const port = value.callbackPort;
	if (clientId !== undefined && !Check(StringSchema, clientId)) {
		return "oauth.clientId must be a string";
	}
	if (clientSecret !== undefined && !Check(StringSchema, clientSecret)) {
		return "oauth.clientSecret must be a string";
	}
	if (port !== undefined && !Check(PortSchema, port)) {
		return "oauth.callbackPort must be a port number";
	}
	if (callbackUrl !== undefined) {
		if (!Check(StringSchema, callbackUrl) || !isLoopbackRedirectUri(callbackUrl)) {
			return "oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment";
		}
		const urlPort = new URL(callbackUrl).port;
		if (urlPort && port !== undefined && Number(urlPort) !== port) {
			return "oauth.callbackUrl and oauth.callbackPort name different ports";
		}
	}
	if (scope !== undefined && !Check(StringSchema, scope)) return "oauth.scope must be a string";
	if (clientName !== undefined && !Check(NonBlankStringSchema, clientName)) {
		return "oauth.clientName must be a non-empty string";
	}
	if (clientRegistration !== undefined && clientRegistration !== "dcr") {
		if (clientRegistration !== "cimd") {
			return 'oauth.clientRegistration must be "dcr" or "cimd"';
		}
		if (clientId !== undefined || clientName !== undefined) {
			return 'oauth.clientRegistration "cimd" cannot be combined with oauth.clientId or oauth.clientName';
		}
		const callback = Check(StringSchema, callbackUrl) ? new URL(callbackUrl) : undefined;
		if (callback && (callback.hostname === "[::1]" || callback.pathname !== "/callback")) {
			return 'oauth.clientRegistration "cimd" requires oauth.callbackUrl on localhost or 127.0.0.1 with path /callback';
		}
	}
	const metadataUrl = value.authServerMetadataUrl;
	if (metadataUrl !== undefined) {
		const url =
			Check(StringSchema, metadataUrl) && URL.canParse(metadataUrl)
				? new URL(metadataUrl)
				: undefined;
		if (
			!url ||
			!(
				url.protocol === "https:" ||
				(url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname))
			)
		) {
			return "oauth.authServerMetadataUrl must be an https URL, or http on localhost, 127.0.0.1, or [::1]";
		}
	}
	return undefined;
}

function resolveExposureAlias(value: McpJson): McpJson {
	return Check(StringSchema, value) ? (MCP_EXPOSURE_ALIASES[value] ?? value) : value;
}

function resolveExposureAliases(value: McpJsonObject): McpJsonObject {
	const { exposure, toolExposure } = value;
	const resolved = { ...value };
	if (exposure !== undefined) resolved.exposure = resolveExposureAlias(exposure);
	if (toolExposure !== undefined && Check(McpJsonObjectSchema, toolExposure)) {
		resolved.toolExposure = Object.fromEntries(
			Object.entries(toolExposure).map(([tool, entry]) => [tool, resolveExposureAlias(entry)]),
		);
	}
	return resolved;
}

function validateCommonFields(name: string, value: McpJsonObject): string | undefined {
	const { exposure, enabled, timeout, toolExposure, description } = value;
	const exposures = MCP_EXPOSURES.map((entry) => `"${entry}"`).join(", ");
	if (exposure !== undefined && !Check(McpExposureSchema, exposure)) {
		return `server "${name}": exposure must be one of ${exposures}`;
	}
	if (toolExposure !== undefined) {
		if (!Check(McpJsonObjectSchema, toolExposure))
			return `server "${name}": toolExposure must map tool names to exposures`;
		for (const [tool, entry] of Object.entries(toolExposure)) {
			if (!Check(McpExposureSchema, entry))
				return `server "${name}": toolExposure "${tool}" must be one of ${exposures}`;
		}
	}
	if (enabled !== undefined && !Check(BooleanSchema, enabled)) {
		return `server "${name}": enabled must be a boolean`;
	}
	if (description !== undefined && !Check(StringSchema, description)) {
		return `server "${name}": description must be a string`;
	}
	if (timeout !== undefined && !Check(TimeoutSchema, timeout)) {
		return `server "${name}": timeout must be a positive number of seconds`;
	}
	return undefined;
}

export function validateMcpServerConfig(name: string, raw: McpJson): McpServerConfig | string {
	if (!SERVER_NAME.test(name))
		return `invalid server name "${name}" (use letters, digits, "_" and "-")`;
	if (!Check(McpJsonObjectSchema, raw)) return `server "${name}" must be an object`;
	const value = resolveExposureAliases(raw);
	const commonError = validateCommonFields(name, value);
	if (commonError) return commonError;
	const { type } = value;
	if (type === "sse") {
		return `server "${name}": legacy SSE transport is not supported; use the streamable HTTP URL`;
	}
	const invalidServer = `server "${name}" is not a valid MCP server`;
	const { url } = value;
	if (
		Check(StringSchema, url) &&
		(type === undefined || type === "http" || type === "streamable-http")
	) {
		if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) {
			return `server "${name}": url must be an http or https URL`;
		}
		if (value.headers !== undefined && !Check(StringMapSchema, value.headers)) {
			return `server "${name}": headers must map names to strings`;
		}
		const oauthError = validateOAuth(value.oauth);
		if (oauthError) return `server "${name}": ${oauthError}`;
		if (value.auth !== undefined) {
			if (!Check(AuthSchema, value.auth)) {
				return `server "${name}": auth.provider must be a provider name`;
			}
			const parsedUrl = new URL(url);
			if (parsedUrl.protocol !== "https:" && !LOOPBACK_HOSTS.includes(parsedUrl.hostname)) {
				return `server "${name}": auth requires an https URL, or http on localhost, 127.0.0.1, or [::1]`;
			}
		}
		const config = type === "streamable-http" ? { ...value, type: "http" } : value;
		return Check(HttpServerSchema, config) ? config : invalidServer;
	}
	if (Check(StringSchema, value.command) && (type === undefined || type === "stdio")) {
		if (value.args !== undefined && !Check(ArgsSchema, value.args)) {
			return `server "${name}": args must be an array of strings`;
		}
		if (value.env !== undefined && !Check(StringMapSchema, value.env)) {
			return `server "${name}": env must map names to strings`;
		}
		if (value.cwd !== undefined && !Check(StringSchema, value.cwd)) {
			return `server "${name}": cwd must be a string`;
		}
		return Check(StdioServerSchema, value) ? value : invalidServer;
	}
	return `server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`;
}

export interface McpConfigFileEntry {
	name: string;
	raw: McpJson;
	path: string;
	scope: McpConfigScope;
	override: boolean;
}

export interface LoadedMcpFiles extends LoadedMcpConfig {
	entries: McpConfigFileEntry[];
	fileErrors: { path: string; message: string }[];
}

interface LoadState {
	servers: Map<string, McpServerEntry>;
	errors: string[];
	entries: McpConfigFileEntry[];
	fileErrors: LoadedMcpFiles["fileErrors"];
	autoEnableCodemode?: boolean;
	admitProjectEntry?: (entry: McpConfigFileEntry) => boolean;
}

function readConfigFile(path: string, scope: McpConfigScope, state: LoadState): void {
	const { servers, errors } = state;
	const fileError = (message: string) => {
		errors.push(`${path}: ${message}`);
		state.fileErrors.push({ path, message });
	};
	if (!existsSync(path)) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
	} catch (error) {
		fileError(error instanceof Error ? error.message : String(error));
		return;
	}
	if (!Check(McpFileSchema, parsed)) {
		fileError('expected an object with an "mcpServers" object');
		return;
	}
	if (Check(BooleanSchema, parsed.autoEnableCodemode)) {
		state.autoEnableCodemode = parsed.autoEnableCodemode;
	} else if (parsed.autoEnableCodemode !== undefined) {
		fileError("autoEnableCodemode must be a boolean");
	}
	for (const [name, value] of Object.entries(parsed.mcpServers ?? {})) {
		const object = Check(McpJsonObjectSchema, value) ? value : undefined;
		const override = scope === "project" && object !== undefined && isOverrideEntry(object);
		const entry: McpConfigFileEntry = {
			name,
			raw: value,
			path,
			scope,
			override,
		};
		state.entries.push(entry);
		if (object && scope === "project" && state.admitProjectEntry?.(entry) === false) {
			continue;
		}
		if (object && override) {
			const base = servers.get(name);
			const extra = Object.keys(object).filter(
				(key) => !(OVERRIDE_KEYS as readonly string[]).includes(key),
			);
			if (!base) {
				errors.push(
					`${path}: server "${name}" needs "command" or "url", or a global server to override`,
				);
			} else if (extra.length > 0) {
				errors.push(
					`${path}: server "${name}": an override can only set ${OVERRIDE_KEYS.join(", ")}`,
				);
			} else {
				const patch = resolveExposureAliases(object);
				const patchError = validateCommonFields(name, patch);
				if (patchError) errors.push(`${path}: ${patchError}`);
				else if (Check(OverrideSchema, patch)) {
					servers.set(name, { ...base, config: { ...base.config, ...patch }, override: path });
				}
			}
			continue;
		}
		const config = validateMcpServerConfig(name, value);
		if (typeof config === "string") {
			errors.push(`${path}: ${config}`);
			continue;
		}
		const clash = [...servers.keys()].find(
			(other) => other !== name && mcpNamespace(other) === mcpNamespace(name),
		);
		if (clash) {
			errors.push(`${path}: server "${name}" conflicts with "${clash}"`);
			continue;
		}
		if (scope === "project" && "url" in config && config.auth) {
			errors.push(`${path}: server "${name}": auth is only allowed in the global mcp.json`);
			continue;
		}
		servers.set(name, { name, config, source: path, scope });
	}
}

export function loadMcpConfigFiles(options: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
	admitProjectEntry?: (entry: McpConfigFileEntry) => boolean;
}): LoadedMcpFiles {
	const state: LoadState = {
		servers: new Map(),
		errors: [],
		entries: [],
		fileErrors: [],
		...(options.admitProjectEntry ? { admitProjectEntry: options.admitProjectEntry } : {}),
	};
	readConfigFile(globalMcpConfigPath(options.agentDir), "global", state);
	const projectConfig = options.projectTrusted ? projectMcpConfigPath(options.cwd) : undefined;
	if (projectConfig) readConfigFile(projectConfig, "project", state);
	return {
		servers: [...state.servers.values()],
		...(state.autoEnableCodemode === undefined
			? {}
			: { autoEnableCodemode: state.autoEnableCodemode }),
		errors: state.errors,
		...(projectConfig ? { projectConfig } : {}),
		entries: state.entries,
		fileErrors: state.fileErrors,
	};
}

function canonicalJson(value: McpJson, preserveOrder = false): string {
	if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
	if (Check(McpJsonObjectSchema, value)) {
		const entries = Object.entries(value);
		if (!preserveOrder)
			entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
		return `{${entries
			.map(
				([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry, key === "toolExposure")}`,
			)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function fingerprintMcpEntry(name: string, raw: McpJson): string {
	return createHash("sha256")
		.update(`${JSON.stringify(name)}:${canonicalJson(raw)}`)
		.digest("hex");
}

export function mcpTargetOf(config: McpServerConfig): string {
	const target =
		"url" in config && typeof config.url === "string"
			? { url: config.url }
			: {
					command: "command" in config ? config.command : null,
					args: "args" in config ? (config.args ?? []) : [],
				};
	return createHash("sha256").update(JSON.stringify(target)).digest("hex");
}

export function mcpToolLabel(server: string, tool: string): string {
	const prefix = `${mcpNamespace(server)}__`;
	return tool.startsWith(prefix) ? tool.slice(prefix.length) : tool;
}

export function grantedMcpTools(
	policy: McpProjectPolicy,
	server: string,
	config: McpServerConfig,
): readonly string[] {
	const grant = policy.toolGrants[server];
	return grant && grant.target === mcpTargetOf(config) ? grant.tools : [];
}

export function normalizeExposureForHost(config: McpServerConfig): McpServerConfig {
	const normalized: McpServerConfig = { ...config };
	if (config.exposure === undefined || config.exposure === "codemode")
		normalized.exposure = "deferred";
	if (config.toolExposure) {
		normalized.toolExposure = Object.fromEntries(
			Object.entries(config.toolExposure).map(([tool, exposure]) => [
				tool,
				exposure === "codemode" ? "deferred" : exposure,
			]),
		);
	}
	return normalized;
}

export interface McpProjectPolicy {
	approvals: Readonly<Record<string, string>>;
	overrides: Readonly<Record<string, McpProjectOverride>>;
	toolGrants: Readonly<Record<string, McpToolGrant>>;
}

// Null-prototype copies, so a server named `__proto__` never reads Object.prototype as its policy.
const ownEntries = <T>(record: Record<string, T> | undefined): Record<string, T> =>
	Object.assign(Object.create(null) as Record<string, T>, record);

export function mcpPolicyOf(
	project: Pick<Project, "mcpApprovals" | "mcpOverrides" | "mcpToolGrants"> | undefined,
): McpProjectPolicy {
	return {
		approvals: ownEntries(project?.mcpApprovals),
		overrides: ownEntries(project?.mcpOverrides),
		toolGrants: ownEntries(project?.mcpToolGrants),
	};
}

export function loadHostMcpConfig(options: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
	policy: McpProjectPolicy;
	disabledInChat?: ReadonlySet<string>;
}): LoadedMcpFiles {
	const { policy, disabledInChat } = options;
	const loaded = loadMcpConfigFiles({
		agentDir: options.agentDir,
		cwd: options.cwd,
		projectTrusted: options.projectTrusted,
		admitProjectEntry: (entry) =>
			policy.approvals[entry.name] === fingerprintMcpEntry(entry.name, entry.raw),
	});
	const servers = loaded.servers.map((server) => {
		const override = server.scope === "global" ? policy.overrides[server.name] : undefined;
		const config: McpServerConfig = { ...server.config };
		if (override?.enabled !== undefined) config.enabled = override.enabled;
		if (override?.exposure !== undefined) config.exposure = override.exposure;
		if (disabledInChat?.has(server.name)) config.enabled = false;
		return { ...server, config: normalizeExposureForHost(config) };
	});
	return { ...loaded, servers };
}
