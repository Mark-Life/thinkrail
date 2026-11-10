import type {
	McpServerConfig,
	McpExposure as PiMcpExposure,
} from "@earendil-works/pi-coding-agent";
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
	type Static,
	str,
	unknown,
	type Validator,
} from "@earendil-works/pi-schema";
import {
	JsonObject,
	type McpActiveExposure,
	McpExposure,
	type McpTransportKind,
	type Same,
} from "@thinkrail/contracts";

type StdioConfig = Extract<McpServerConfig, { command: string }>;
type HttpConfig = Extract<McpServerConfig, { url: string }>;

type Exposure = Same<McpExposure, PiMcpExposure>;
export type McpActiveExposureTie = Same<McpActiveExposure, Exclude<PiMcpExposure, "codemode">>;
export type McpTransportKindTie = Same<McpTransportKind, NonNullable<McpServerConfig["type"]>>;
const StringMap = map(str());
const StringList = arr(str());
const Timeout = num({ exclusiveMinimum: 0 });
const Port = int({ minimum: 1, maximum: 65535 });
const ClientName = str({ pattern: "\\S" });
const Auth = obj({ provider: str({ minLength: 1 }) }, { open: true });

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
export type McpOAuth = Same<Static<typeof OAuth>, NonNullable<HttpConfig["oauth"]>>;

const COMMON_FIELDS = {
	exposure: opt(McpExposure),
	toolExposure: opt(map(McpExposure)),
	enabled: opt(bool()),
	description: opt(str()),
	timeout: opt(Timeout),
};

const HTTP_FIELDS = { headers: opt(StringMap), oauth: opt(OAuth), auth: opt(Auth) };

const STDIO_FIELDS = { args: opt(StringList), env: opt(StringMap), cwd: opt(str()) };

const HttpServer = obj(
	{
		...COMMON_FIELDS,
		...HTTP_FIELDS,
		type: opt(oneOf(["http", "streamable-http"])),
		url: str(),
	},
	{ open: true },
);
/** pi reads `streamable-http` as `http`, so the parse result types `type` as pi does. */
type HttpServer = Same<Omit<Static<typeof HttpServer>, "type"> & { type?: "http" }, HttpConfig>;

const StdioServer = obj(
	{ ...COMMON_FIELDS, ...STDIO_FIELDS, type: opt(lit("stdio")), command: str() },
	{ open: true },
);
type StdioServer = Same<Static<typeof StdioServer>, StdioConfig>;

const McpFile = obj(
	{ mcpServers: opt(map(unknown())), autoEnableCodemode: opt(unknown()) },
	{ open: true },
);

export type McpFile = Static<typeof McpFile>;

export const isJsonObject = JsonObject.check;
export const isMcpFile = compile(McpFile).check;
export const isExposure: Validator<Exposure>["check"] = compile(McpExposure).check;
export const CommonFields = compile(obj(COMMON_FIELDS, { open: true }));
export const HttpFields = compile(obj(HTTP_FIELDS, { open: true }));
export const StdioFields = compile(obj(STDIO_FIELDS, { open: true }));
const isHttpServer = compile(HttpServer).check;
const isStdioServer: Validator<StdioServer>["check"] = compile(StdioServer).check;

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
