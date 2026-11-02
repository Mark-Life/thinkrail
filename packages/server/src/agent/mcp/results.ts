import {
	arr,
	compile,
	lit,
	obj,
	opt,
	type Static,
	str,
	union,
	unknown,
} from "@earendil-works/pi-schema";
import type { McpContentBlockSummary, McpResultSummary } from "@thinkrail/contracts";
import { isJsonObject } from "./schemas";

export const MCP_SUMMARY_BYTES = 64 * 1024;
const RESOURCE_TOOLS = new Set([
	"list_mcp_resources",
	"list_mcp_resource_templates",
	"read_mcp_resource",
]);

export function isMcpResultTool(toolName: string): boolean {
	return toolName.startsWith("mcp__") || RESOURCE_TOOLS.has(toolName);
}

const Resource = obj({ uri: opt(str()), mimeType: opt(str()), text: opt(str()) }, { open: true });
const isResource = compile(Resource).check;

const ContentBlock = union([
	obj({ type: lit("text"), text: opt(str()) }, { open: true }),
	obj({ type: lit("image"), mimeType: opt(str()) }, { open: true }),
	obj({ type: lit("audio"), mimeType: opt(str()) }, { open: true }),
	obj(
		{ type: lit("resource_link"), uri: opt(str()), name: opt(str()), mimeType: opt(str()) },
		{ open: true },
	),
	obj({ type: lit("resource"), resource: Resource }, { open: true }),
]);
const isContentBlock = compile(ContentBlock).check;
const isEntryList = compile(arr(unknown())).check;
const hasFullOutputPath = compile(obj({ fullOutputPath: str() }, { open: true })).check;

export function mcpFullOutputPath(details: unknown): string | undefined {
	return hasFullOutputPath(details) ? details.fullOutputPath : undefined;
}

function blockSummary(block: Static<typeof ContentBlock>): McpContentBlockSummary {
	switch (block.type) {
		case "text":
			return { kind: "text", chars: block.text?.length ?? 0 };
		case "image":
			return { kind: "image", mimeType: block.mimeType ?? "image/*" };
		case "audio":
			return { kind: "audio", mimeType: block.mimeType ?? "audio/*" };
		case "resource_link":
			return {
				kind: "resource_link",
				uri: block.uri ?? "",
				...(block.name ? { name: block.name } : {}),
				...(block.mimeType ? { mimeType: block.mimeType } : {}),
			};
		case "resource":
			return resourceSummary(block.resource);
	}
}

function resourceSummary(resource: Static<typeof Resource>): McpContentBlockSummary {
	return {
		kind: "resource",
		uri: resource.uri ?? "",
		...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
		...(resource.text !== undefined ? { chars: resource.text.length } : {}),
	};
}

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? "");

function boundedBlocks(
	all: McpContentBlockSummary[],
	budget: number,
): { kept: Pick<McpResultSummary, "blocks" | "omittedBlocks">; remaining: number } {
	const blocks: McpContentBlockSummary[] = [];
	let used = bytes([]);
	for (const block of all) {
		const size = bytes(block) + 1;
		if (used + size > budget) break;
		blocks.push(block);
		used += size;
	}
	const omitted = all.length - blocks.length;
	return {
		kept: { blocks, ...(omitted > 0 ? { omittedBlocks: omitted } : {}) },
		remaining: budget - used,
	};
}

function boundedStructured(
	value: unknown,
	budget: number,
): Pick<McpResultSummary, "structuredContent" | "structuredContentTruncated"> {
	if (value === undefined) return {};
	const json = JSON.stringify(value);
	if (json === undefined) return {};
	return Buffer.byteLength(json) <= budget
		? { structuredContent: value }
		: { structuredContentTruncated: true };
}

export function summarizeMcpResult(
	toolName: string,
	structured: unknown,
	isError: boolean,
): McpResultSummary | null {
	if (!isJsonObject(structured)) return null;
	const flag = isError ? { isError: true } : {};
	if (toolName === "read_mcp_resource") {
		const contents = isEntryList(structured.contents) ? structured.contents : [];
		const { kept } = boundedBlocks(
			contents.filter(isResource).map(resourceSummary),
			MCP_SUMMARY_BYTES,
		);
		return { ...kept, ...flag };
	}
	if (RESOURCE_TOOLS.has(toolName))
		return { blocks: [], ...boundedStructured(structured, MCP_SUMMARY_BYTES), ...flag };
	const content = isEntryList(structured.content) ? structured.content : [];
	const { kept, remaining } = boundedBlocks(
		content.filter(isContentBlock).map(blockSummary),
		MCP_SUMMARY_BYTES,
	);
	return { ...kept, ...boundedStructured(structured.structuredContent, remaining), ...flag };
}
