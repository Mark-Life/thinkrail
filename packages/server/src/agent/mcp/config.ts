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
import {
	CommonFields,
	HttpFields,
	isJsonObject,
	isMcpFile,
	MCP_EXPOSURES,
	type McpOAuth,
	parseHttpServer,
	parseStdioServer,
	refusedPath,
	StdioFields,
} from "./schemas";

// Port of pi's `core/mcp-servers.ts` and `extensions/mcp/config.ts` (MIT, Earendil Works).

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const MCP_EXPOSURE_ALIASES: Record<string, McpExposure> = { "codemode-deferred": "codemode" };
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

export function isOverrideEntry(value: Record<string, unknown>): boolean {
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

const CALLBACK_URL_PROBLEM =
	"oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment";
const METADATA_URL_PROBLEM =
	"oauth.authServerMetadataUrl must be an https URL, or http on localhost, 127.0.0.1, or [::1]";

const OAUTH_FIELD_PROBLEMS: Readonly<Record<string, string>> = {
	clientId: "oauth.clientId must be a string",
	clientSecret: "oauth.clientSecret must be a string",
	callbackPort: "oauth.callbackPort must be a port number",
	callbackUrl: CALLBACK_URL_PROBLEM,
	scope: "oauth.scope must be a string",
	clientName: "oauth.clientName must be a non-empty string",
	clientRegistration: 'oauth.clientRegistration must be "auto", "dcr", or "cimd"',
	authServerMetadataUrl: METADATA_URL_PROBLEM,
};

function oauthProblem(oauth: McpOAuth): string | undefined {
	const { callbackPort, callbackUrl, clientRegistration, authServerMetadataUrl } = oauth;
	if (callbackUrl !== undefined) {
		if (!isLoopbackRedirectUri(callbackUrl)) return CALLBACK_URL_PROBLEM;
		const urlPort = new URL(callbackUrl).port;
		if (urlPort && callbackPort !== undefined && Number(urlPort) !== callbackPort) {
			return "oauth.callbackUrl and oauth.callbackPort name different ports";
		}
	}
	if (clientRegistration === "cimd") {
		if (oauth.clientId !== undefined || oauth.clientName !== undefined) {
			return 'oauth.clientRegistration "cimd" cannot be combined with oauth.clientId or oauth.clientName';
		}
		const callback = callbackUrl === undefined ? undefined : new URL(callbackUrl);
		if (callback && (callback.hostname === "[::1]" || callback.pathname !== "/callback")) {
			return 'oauth.clientRegistration "cimd" requires oauth.callbackUrl on localhost or 127.0.0.1 with path /callback';
		}
	}
	if (authServerMetadataUrl !== undefined) {
		const url = URL.canParse(authServerMetadataUrl) ? new URL(authServerMetadataUrl) : undefined;
		const allowed =
			url?.protocol === "https:" ||
			(url?.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname));
		if (!allowed) return METADATA_URL_PROBLEM;
	}
	return undefined;
}

function resolveExposureAlias(value: unknown): unknown {
	return typeof value === "string" ? (MCP_EXPOSURE_ALIASES[value] ?? value) : value;
}

function resolveExposureAliases(value: Record<string, unknown>): Record<string, unknown> {
	const { exposure, toolExposure } = value;
	const resolved = { ...value };
	if (exposure !== undefined) resolved.exposure = resolveExposureAlias(exposure);
	if (isJsonObject(toolExposure)) {
		resolved.toolExposure = Object.fromEntries(
			Object.entries(toolExposure).map(([tool, entry]) => [tool, resolveExposureAlias(entry)]),
		);
	}
	return resolved;
}

function commonFieldProblem([field, tool]: string[]): string {
	const exposures = MCP_EXPOSURES.map((entry) => `"${entry}"`).join(", ");
	switch (field) {
		case "exposure":
			return `exposure must be one of ${exposures}`;
		case "toolExposure":
			return tool === undefined
				? "toolExposure must map tool names to exposures"
				: `toolExposure "${tool}" must be one of ${exposures}`;
		case "enabled":
			return "enabled must be a boolean";
		case "description":
			return "description must be a string";
		default:
			return "timeout must be a positive number of seconds";
	}
}

function httpFieldProblem([field, oauthField]: string[]): string {
	if (field === "headers") return "headers must map names to strings";
	if (field === "auth") return "auth.provider must be a provider name";
	return (
		(oauthField === undefined ? undefined : OAUTH_FIELD_PROBLEMS[oauthField]) ??
		"oauth must be an object"
	);
}

function stdioFieldProblem([field]: string[]): string {
	if (field === "args") return "args must be an array of strings";
	if (field === "env") return "env must map names to strings";
	return "cwd must be a string";
}

function httpServerProblem(value: Record<string, unknown>, url: string): string | undefined {
	if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) {
		return "url must be an http or https URL";
	}
	if (!HttpFields.check(value)) return httpFieldProblem(refusedPath(HttpFields, value));
	const oauthError = value.oauth === undefined ? undefined : oauthProblem(value.oauth);
	if (oauthError) return oauthError;
	const { protocol, hostname } = new URL(url);
	if (value.auth !== undefined && protocol !== "https:" && !LOOPBACK_HOSTS.includes(hostname)) {
		return "auth requires an https URL, or http on localhost, 127.0.0.1, or [::1]";
	}
	return undefined;
}

const notAServer = (name: string) => `server "${name}" is not a valid MCP server`;

export function validateMcpServerConfig(name: string, raw: unknown): McpServerConfig | string {
	if (!SERVER_NAME.test(name))
		return `invalid server name "${name}" (use letters, digits, "_" and "-")`;
	if (!isJsonObject(raw)) return `server "${name}" must be an object`;
	const value = resolveExposureAliases(raw);
	const { type, url, command } = value;
	if (!CommonFields.check(value)) {
		return `server "${name}": ${commonFieldProblem(refusedPath(CommonFields, value))}`;
	}
	if (type === "sse") {
		return `server "${name}": legacy SSE transport is not supported; use the streamable HTTP URL`;
	}
	if (
		typeof url === "string" &&
		(type === undefined || type === "http" || type === "streamable-http")
	) {
		const problem = httpServerProblem(value, url);
		if (problem) return `server "${name}": ${problem}`;
		return parseHttpServer(value) ?? notAServer(name);
	}
	if (typeof command === "string" && (type === undefined || type === "stdio")) {
		if (!StdioFields.check(value)) {
			return `server "${name}": ${stdioFieldProblem(refusedPath(StdioFields, value))}`;
		}
		return parseStdioServer(value) ?? notAServer(name);
	}
	return `server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`;
}

export interface McpConfigFileEntry {
	name: string;
	raw: unknown;
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
	if (!isMcpFile(parsed)) {
		fileError('expected an object with an "mcpServers" object');
		return;
	}
	if (typeof parsed.autoEnableCodemode === "boolean") {
		state.autoEnableCodemode = parsed.autoEnableCodemode;
	} else if (parsed.autoEnableCodemode !== undefined) {
		fileError("autoEnableCodemode must be a boolean");
	}
	for (const [name, value] of Object.entries(parsed.mcpServers ?? {})) {
		const entry: McpConfigFileEntry = {
			name,
			raw: value,
			path,
			scope,
			override: scope === "project" && isJsonObject(value) && isOverrideEntry(value),
		};
		state.entries.push(entry);
		if (scope === "project" && isJsonObject(value) && state.admitProjectEntry?.(entry) === false) {
			continue;
		}
		if (scope === "project" && isJsonObject(value) && isOverrideEntry(value)) {
			const base = servers.get(name);
			const extra = Object.keys(value).filter(
				(key) => !OVERRIDE_KEYS.some((allowed) => allowed === key),
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
				const config = validateMcpServerConfig(name, { ...base.config, ...value });
				if (typeof config === "string") errors.push(`${path}: ${config}`);
				else servers.set(name, { ...base, config, override: path });
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

function canonicalJson(value: unknown, preserveOrder = false): string {
	if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
	if (isJsonObject(value)) {
		const keys = Object.keys(value);
		if (!preserveOrder) keys.sort();
		return `{${keys
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], key === "toolExposure")}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function fingerprintMcpEntry(name: string, raw: unknown): string {
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
const ownEntries = <T>(record: Record<string, T> | undefined): Record<string, T> => {
	const copy: Record<string, T> = { ...record };
	Object.setPrototypeOf(copy, null);
	return copy;
};

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
