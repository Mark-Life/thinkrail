import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { McpContentBlockSummary, McpResultSummary } from "@thinkrail/contracts";
import { Type } from "typebox";
import { Check } from "typebox/value";

export const MCP_SUMMARY_BYTES = 64 * 1024;
const RESOURCE_TOOLS = new Set([
	"list_mcp_resources",
	"list_mcp_resource_templates",
	"read_mcp_resource",
]);

export function isMcpResultTool(toolName: string): boolean {
	return toolName.startsWith("mcp__") || RESOURCE_TOOLS.has(toolName);
}

const ResourceSchema = Type.Object({
	uri: Type.Optional(Type.String()),
	mimeType: Type.Optional(Type.String()),
	text: Type.Optional(Type.String()),
});

const BlockSchema = Type.Union([
	Type.Object({ type: Type.Literal("text"), text: Type.Optional(Type.String()) }),
	Type.Object({ type: Type.Literal("image"), mimeType: Type.Optional(Type.String()) }),
	Type.Object({ type: Type.Literal("audio"), mimeType: Type.Optional(Type.String()) }),
	Type.Object({
		type: Type.Literal("resource_link"),
		uri: Type.Optional(Type.String()),
		name: Type.Optional(Type.String()),
		mimeType: Type.Optional(Type.String()),
	}),
	Type.Object({ type: Type.Literal("resource"), resource: ResourceSchema }),
]);

const EntriesSchema = Type.Array(Type.Unknown());

const ResultSchema = Type.Object({
	content: Type.Optional(Type.Unknown()),
	contents: Type.Optional(Type.Unknown()),
	structuredContent: Type.Optional(Type.Unknown()),
});

function blockSummary(block: unknown): McpContentBlockSummary | null {
	if (!Check(BlockSchema, block)) return null;
	switch (block.type) {
		case "text":
			return { kind: "text", chars: block.text?.length ?? 0 };
		case "image":
			return { kind: "image", mimeType: block.mimeType ?? "image/*" };
		case "audio":
			return { kind: "audio", mimeType: block.mimeType ?? "audio/*" };
		case "resource_link": {
			const { name, mimeType } = block;
			return {
				kind: "resource_link",
				uri: block.uri ?? "",
				...(name ? { name } : {}),
				...(mimeType ? { mimeType } : {}),
			};
		}
		case "resource":
			return resourceSummary(block.resource);
	}
}

function resourceSummary(resource: unknown): McpContentBlockSummary | null {
	if (!Check(ResourceSchema, resource)) return null;
	const { mimeType, text: body } = resource;
	return {
		kind: "resource",
		uri: resource.uri ?? "",
		...(mimeType ? { mimeType } : {}),
		...(body !== undefined ? { chars: body.length } : {}),
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
	structured: ToolResultEvent["structuredContent"],
	isError: boolean,
): McpResultSummary | null {
	if (!Check(ResultSchema, structured)) return null;
	const flag = isError ? { isError: true } : {};
	if (toolName === "read_mcp_resource") {
		const contents = Check(EntriesSchema, structured.contents) ? structured.contents : [];
		const { kept } = boundedBlocks(
			contents.flatMap((entry) => resourceSummary(entry) ?? []),
			MCP_SUMMARY_BYTES,
		);
		return { ...kept, ...flag };
	}
	if (RESOURCE_TOOLS.has(toolName))
		return { blocks: [], ...boundedStructured(structured, MCP_SUMMARY_BYTES), ...flag };
	const content = Check(EntriesSchema, structured.content) ? structured.content : [];
	const { kept, remaining } = boundedBlocks(
		content.flatMap((block) => blockSummary(block) ?? []),
		MCP_SUMMARY_BYTES,
	);
	return { ...kept, ...boundedStructured(structured.structuredContent, remaining), ...flag };
}
