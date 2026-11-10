import { lit, num, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import { wireObj } from "./wire";

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
