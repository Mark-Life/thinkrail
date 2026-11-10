import { arr, bool, num, opt, type Static, str } from "@earendil-works/pi-schema";
import { StoredWorkspaceId, WorkspaceId } from "./ids";
import { Ack, wireObj } from "./wire";

export const TerminalTabInfo = wireObj({ tabKey: str(), title: str() });
export type TerminalTabInfo = Static<typeof TerminalTabInfo>;

export const TerminalDataPush = wireObj({ id: str(), data: str(), truncated: opt(bool()) });
export type TerminalDataPush = Static<typeof TerminalDataPush>;

export const TerminalExitPush = wireObj({ id: str(), exitCode: num() });
export type TerminalExitPush = Static<typeof TerminalExitPush>;

export const TerminalDetachedPush = wireObj({ workspaceId: StoredWorkspaceId, tabKey: str() });
export type TerminalDetachedPush = Static<typeof TerminalDetachedPush>;

export const TerminalTabsPush = wireObj({
	workspaceId: StoredWorkspaceId,
	tabs: arr(TerminalTabInfo),
});
export type TerminalTabsPush = Static<typeof TerminalTabsPush>;

export const TERMINAL_METHODS = {
	"terminal.reserve": {
		params: wireObj({ workspaceId: WorkspaceId, tabKey: str(), title: str() }),
		result: wireObj({ tab: TerminalTabInfo }),
	},
	"terminal.attach": {
		params: wireObj({
			workspaceId: WorkspaceId,
			tabKey: str(),
			title: opt(str()),
			cols: opt(num()),
			rows: opt(num()),
		}),
		result: wireObj({ id: str(), created: bool(), replay: opt(str()) }),
	},
	"terminal.list": {
		params: wireObj({ workspaceId: WorkspaceId }),
		result: wireObj({ tabs: arr(TerminalTabInfo) }),
	},
	"terminal.write": { params: wireObj({ id: str(), data: str() }), result: Ack },
	"terminal.resize": { params: wireObj({ id: str(), cols: num(), rows: num() }), result: Ack },
	"terminal.close": {
		params: wireObj({ workspaceId: WorkspaceId, tabKey: str(), force: opt(bool()) }),
		result: wireObj({ closed: bool(), busy: bool() }),
	},
};

export const TERMINAL_CHANNELS = {
	"terminal.data": TerminalDataPush,
	"terminal.exit": TerminalExitPush,
	"terminal.detached": TerminalDetachedPush,
	"terminal.tabs": TerminalTabsPush,
};
