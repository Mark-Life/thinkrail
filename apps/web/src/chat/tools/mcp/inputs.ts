/**
 * The arguments of pi's built-in MCP tools the cards read. pi declares them as JSON Schema in modules it
 * does not export (`extensions/mcp/resources`, `extensions/tool-search/tool`), so these are untied; the
 * MCP tools part of `pi-compatibility.md` lists them for review on a pi upgrade.
 */
export interface McpListResourcesInput {
	server?: string;
	cursor?: string;
}

export interface ReadMcpResourceInput {
	server: string;
	uri: string;
}

export interface ToolSearchInput {
	query: string;
	limit?: number;
}
