import type { McpExposure, McpServerConfig } from "@earendil-works/pi-coding-agent";
import {
	arr,
	bool,
	compile,
	int,
	lit,
	map,
	num,
	obj,
	oneOf,
	opt,
	type Schema,
	type Static,
	str,
	unknown,
} from "@earendil-works/pi-schema";
import { JsonObject } from "@thinkrail/contracts";

export const MCP_EXPOSURES = ["codemode", "deferred", "direct", "hidden"] as const;

const Exposure: Schema<McpExposure> = oneOf(MCP_EXPOSURES);
const StringMap = map(str());
const StringList = arr(str());
const Timeout = num({ exclusiveMinimum: 0 });
const Port = int({ minimum: 1, maximum: 65535 });
const ClientName = str({ pattern: "\\S" });
const Auth = obj({ provider: str({ minLength: 1 }) }, { open: true });
const HttpType: Schema<"http"> = { enum: ["http", "streamable-http"] };

const OAuth = obj(
	{
		clientId: opt(str()),
		clientSecret: opt(str()),
		callbackPort: opt(Port),
		callbackUrl: opt(str()),
		scope: opt(str()),
		clientName: opt(ClientName),
		clientRegistration: opt(oneOf(["auto", "dcr", "cimd"])),
		authServerMetadataUrl: opt(str()),
	},
	{ open: true },
);

const COMMON_FIELDS = {
	exposure: opt(Exposure),
	toolExposure: opt(map(Exposure)),
	description: opt(str()),
	enabled: opt(bool()),
	timeout: opt(Timeout),
};

const HttpServer = obj(
	{
		...COMMON_FIELDS,
		type: opt(HttpType),
		url: str(),
		headers: opt(StringMap),
		oauth: opt(OAuth),
		auth: opt(Auth),
	},
	{ open: true },
);

const StdioServer = obj(
	{
		...COMMON_FIELDS,
		type: opt(lit("stdio")),
		command: str(),
		args: opt(StringList),
		env: opt(StringMap),
		cwd: opt(str()),
	},
	{ open: true },
);

const McpFile = obj(
	{ mcpServers: opt(map(unknown())), autoEnableCodemode: opt(unknown()) },
	{ open: true },
);

export type McpFile = Static<typeof McpFile>;

export const isJsonObject = JsonObject.check;
export const isMcpFile = compile(McpFile).check;
export const isExposure = compile(Exposure).check;
export const isStringMap = compile(StringMap).check;
export const isStringList = compile(StringList).check;
export const isTimeout = compile(Timeout).check;
export const isPort = compile(Port).check;
export const isClientName = compile(ClientName).check;
export const isAuth = compile(Auth).check;
const isHttpServer = compile(HttpServer).check;
const isStdioServer = compile(StdioServer).check;

export function parseHttpServer(value: unknown): McpServerConfig | undefined {
	return isHttpServer(value) ? value : undefined;
}

export function parseStdioServer(value: unknown): McpServerConfig | undefined {
	return isStdioServer(value) ? value : undefined;
}
