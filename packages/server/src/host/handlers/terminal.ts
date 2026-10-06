import {
	attachTerminal,
	closeTerminalTab,
	listTerminals,
	reserveTerminal,
	resizeTerminal,
	writeTerminal,
} from "../../terminal";
import { getWorkspace } from "../../workspaces";
import type { HandlersFor } from "./types";

export const terminalHandlers: HandlersFor<"terminal"> = {
	"terminal.reserve": (p) => {
		getWorkspace(p.workspaceId);
		return { tab: reserveTerminal(p.workspaceId, p.tabKey, p.title) };
	},
	"terminal.attach": (p, ctx) => {
		return attachTerminal(p.workspaceId, p.tabKey, ctx.clientKey, p);
	},
	"terminal.list": (params) => ({
		tabs: listTerminals(params.workspaceId),
	}),
	"terminal.write": (p, ctx) => {
		writeTerminal(p.id, p.data, ctx.clientKey);
		return { ok: true } as const;
	},
	"terminal.resize": (p, ctx) => {
		resizeTerminal(p.id, p.cols, p.rows, ctx.clientKey);
		return { ok: true } as const;
	},
	"terminal.close": (p) => {
		return closeTerminalTab(p.workspaceId, p.tabKey, p.force ?? false);
	},
};
