import type {
	McpServerConfig,
	McpExposure as PiMcpExposure,
} from "@earendil-works/pi-coding-agent";
import {
	compile,
	map,
	obj,
	opt,
	type Static,
	unknown,
	type Validator,
} from "@earendil-works/pi-schema";
import {
	JsonObject,
	MCP_COMMON_FIELDS,
	MCP_HTTP_FIELDS,
	MCP_STDIO_FIELDS,
	type McpActiveExposure,
	McpExposure,
	McpHttpServerConfig,
	type McpOAuthConfig,
	McpStdioServerConfig,
	type McpTransportKind,
	type Same,
} from "@thinkrail/contracts";

type StdioConfig = Extract<McpServerConfig, { command: string }>;
type HttpConfig = Extract<McpServerConfig, { url: string }>;

type Exposure = Same<McpExposure, PiMcpExposure>;
export type McpActiveExposureTie = Same<McpActiveExposure, Exclude<PiMcpExposure, "codemode">>;
export type McpTransportKindTie = Same<McpTransportKind, NonNullable<McpServerConfig["type"]>>;
export type McpOAuth = Same<McpOAuthConfig, NonNullable<HttpConfig["oauth"]>>;
/** pi reads `streamable-http` as `http`, so the parse result types `type` as pi does. */
type HttpServer = Same<
	Omit<McpHttpServerConfig, "type"> & {
		type?: Exclude<NonNullable<McpHttpServerConfig["type"]>, "streamable-http">;
	},
	HttpConfig
>;
type StdioServer = Same<McpStdioServerConfig, StdioConfig>;

const McpFile = obj(
	{ mcpServers: opt(map(unknown())), autoEnableCodemode: opt(unknown()) },
	{ open: true },
);

export type McpFile = Static<typeof McpFile>;

export const isJsonObject = JsonObject.check;
export const isMcpFile = compile(McpFile).check;
export const isExposure: Validator<Exposure>["check"] = compile(McpExposure).check;
export const CommonFields = compile(obj(MCP_COMMON_FIELDS, { open: true }));
export const HttpFields = compile(obj(MCP_HTTP_FIELDS, { open: true }));
export const StdioFields = compile(obj(MCP_STDIO_FIELDS, { open: true }));
const isHttpServer = compile(McpHttpServerConfig).check;
const isStdioServer: Validator<StdioServer>["check"] = compile(McpStdioServerConfig).check;

export function refusedPath<T>(validator: Validator<T>, value: unknown): string[] {
	const path = validator.errors(value)[0]?.path ?? "";
	return path
		.split("/")
		.slice(1)
		.map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

export function parseHttpServer(value: unknown): HttpServer | undefined {
	if (!isHttpServer(value)) return undefined;
	const { type, ...server } = value;
	return type === undefined ? server : { ...server, type: "http" };
}

export function parseStdioServer(value: unknown): StdioServer | undefined {
	return isStdioServer(value) ? value : undefined;
}
