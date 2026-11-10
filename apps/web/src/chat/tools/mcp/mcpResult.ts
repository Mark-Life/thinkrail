import {
	arr,
	compile,
	lit,
	map,
	obj,
	type Static,
	str,
	unknown,
	type Validator,
} from "@earendil-works/pi-schema";
import {
	isMcpContentBlockSummary,
	JsonObject,
	keepValidFields,
	McpResultSummary,
	McpToolDetails,
	type Same,
	type TextContent,
} from "@thinkrail/contracts";
import { resultText } from "@thinkrail/extension-api/web";

export const MCP_TOOL_PREFIX = "mcp__";

const ResultDetails = compile(obj({ details: map(unknown()) }, { open: true }));
const ResultContent = compile(obj({ content: arr(unknown()) }, { open: true }));
const TextShape = obj({ type: lit("text"), text: str() }, { open: true });
const TextBlock: Validator<Same<Static<typeof TextShape>, Pick<TextContent, "type" | "text">>> =
	compile(TextShape);
const SummaryBlocks = compile(obj({ blocks: arr(unknown()) }, { open: true }));
const FullOutputPath = compile(obj({ fullOutputPath: str({ minLength: 1 }) }, { open: true }));
const ToolDetails = compile(McpToolDetails);
const ResultSummary = compile(McpResultSummary);

const stringOf = (value: unknown): string | undefined =>
	typeof value === "string" ? value : undefined;

function detailsOf(result: unknown) {
	return ResultDetails.check(result) ? result.details : null;
}

export interface McpCallTitle {
	server: string;
	tool: string;
}

export function parseMcpToolName(toolName: string): McpCallTitle | null {
	if (!toolName.startsWith(MCP_TOOL_PREFIX)) return null;
	const rest = toolName.slice(MCP_TOOL_PREFIX.length);
	const split = rest.indexOf("__");
	return split < 0
		? { server: rest, tool: "" }
		: { server: rest.slice(0, split), tool: rest.slice(split + 2) };
}

export function readMcpToolDetails(result: unknown): McpToolDetails | null {
	const kept = keepValidFields(detailsOf(result), ToolDetails);
	if (!kept) return null;
	const { server, tool, fullOutputPath } = kept.fields;
	return { server, tool, ...(fullOutputPath ? { fullOutputPath } : {}) };
}

export function mcpCallTitle(toolName: string, result: unknown): McpCallTitle {
	const details = readMcpToolDetails(result);
	if (details?.server && details.tool) return { server: details.server, tool: details.tool };
	return parseMcpToolName(toolName) ?? { server: "", tool: toolName };
}

export function mcpFullOutputPath(result: unknown): string | null {
	const details = detailsOf(result);
	return FullOutputPath.check(details) ? details.fullOutputPath : null;
}

/** The host summary; a malformed block or field drops alone, and a summary with no block list is absent. */
export function readMcpResultSummary(result: unknown): McpResultSummary | null {
	const summary = detailsOf(result)?.thinkrail;
	if (!SummaryBlocks.check(summary)) return null;
	const blocks = summary.blocks.filter(isMcpContentBlockSummary);
	return keepValidFields({ ...summary, blocks }, ResultSummary)?.fields ?? null;
}

export function mcpText(result: unknown): string {
	if (!ResultContent.check(result)) return resultText(result);
	return result.content.flatMap((block) => (TextBlock.check(block) ? [block.text] : [])).join("\n");
}

const ARGS_SUMMARY_CHARS = 100;

export function mcpArgsSummary(args: Record<string, unknown>): string {
	const pairs = Object.entries(args)
		.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`)
		.join(" ");
	return pairs.length > ARGS_SUMMARY_CHARS ? `${pairs.slice(0, ARGS_SUMMARY_CHARS - 1)}…` : pairs;
}

export type McpCliAction = "sign-in" | "provider-sign-in" | "settings";

const SIGN_IN_PHRASE = /\b(?:requires|needs) sign-in\b|\bmcp login\b/i;
const MCP_COMMAND_PHRASE = /\brun \/mcp\b/i;

export function mcpCliAction(text: string): McpCliAction | null {
	if (/\brun \/login\s+\S+/i.test(text)) return "provider-sign-in";
	if (SIGN_IN_PHRASE.test(text)) return "sign-in";
	if (MCP_COMMAND_PHRASE.test(text)) return "settings";
	return null;
}

const CLI_INSTRUCTION = /(?:^|\s)(?:Run \/mcp|pi mcp login)\b[^.\n]*\.?/gi;

/** The failure text without pi's CLI instruction, for when the card offers the in-app action instead. */
export function stripMcpCliInstruction(text: string): string {
	const stripped = text
		.replace(/\bRun \/login (\S+) to sign in\./gi, 'Sign in to provider "$1" in Settings.')
		.replace(CLI_INSTRUCTION, "")
		.replace(/[ \t]+\n/g, "\n")
		.trim();
	return stripped || text;
}

export interface McpListedItem {
	server: string;
	uri: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
}

export interface McpListingError {
	server: string;
	error: string;
}

export interface McpListing {
	items: McpListedItem[];
	nextCursor?: string;
	errors: McpListingError[];
}

const LISTING_FIELDS: Readonly<Record<string, { items: string; uri: string }>> = {
	list_mcp_resources: { items: "resources", uri: "uri" },
	list_mcp_resource_templates: { items: "resourceTemplates", uri: "uriTemplate" },
};

function listedItem(value: unknown, uriField: string, fallbackServer: string): McpListedItem[] {
	if (!JsonObject.check(value)) return [];
	const uri = stringOf(value[uriField]);
	if (!uri) return [];
	const title = stringOf(value.title);
	const description = stringOf(value.description);
	const mimeType = stringOf(value.mimeType);
	return [
		{
			server: stringOf(value.server) ?? fallbackServer,
			uri,
			name: stringOf(value.name) || uri,
			...(title ? { title } : {}),
			...(description ? { description } : {}),
			...(mimeType ? { mimeType } : {}),
		},
	];
}

function listingError(value: unknown): McpListingError[] {
	if (!JsonObject.check(value)) return [];
	const error = stringOf(value.error);
	return error ? [{ server: stringOf(value.server) ?? "", error }] : [];
}

export function parseMcpListing(toolName: string, payload: unknown): McpListing | null {
	const fields = LISTING_FIELDS[toolName];
	if (!fields || !JsonObject.check(payload)) return null;
	const items = payload[fields.items];
	if (!Array.isArray(items)) return null;
	const server = stringOf(payload.server) ?? "";
	const nextCursor = stringOf(payload.nextCursor);
	return {
		items: items.flatMap((item) => listedItem(item, fields.uri, server)),
		...(nextCursor ? { nextCursor } : {}),
		errors: Array.isArray(payload.errors) ? payload.errors.flatMap(listingError) : [],
	};
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export function readMcpListing(toolName: string, result: unknown): McpListing | null {
	return (
		parseMcpListing(toolName, readMcpResultSummary(result)?.structuredContent) ??
		parseMcpListing(toolName, parseJson(mcpText(result).trim()))
	);
}

export function readToolSearchLoaded(result: unknown): string[] | null {
	const loaded = detailsOf(result)?.loaded;
	return Array.isArray(loaded)
		? loaded.filter((name): name is string => typeof name === "string")
		: null;
}

const LOADED_TOOL_LINE = /^- ([^\s:]+): ?(.*)$/;

export function toolSearchDescriptions(text: string): Map<string, string> {
	const descriptions = new Map<string, string>();
	for (const line of text.split("\n")) {
		const match = LOADED_TOOL_LINE.exec(line);
		if (match?.[1]) descriptions.set(match[1], match[2] ?? "");
	}
	return descriptions;
}
