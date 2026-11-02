import { arr, bool, num, opt, type Static, str } from "@earendil-works/pi-schema";
import { Ack, wireObj } from "./wire";

export const TerminalTabInfo = wireObj({ tabKey: str(), title: str() });
export type TerminalTabInfo = Static<typeof TerminalTabInfo>;

export const TERMINAL_METHODS = {
	"terminal.reserve": {
		params: wireObj({ workspaceId: str(), tabKey: str(), title: str() }),
		result: wireObj({ tab: TerminalTabInfo }),
	},
	"terminal.attach": {
		params: wireObj({
			workspaceId: str(),
			tabKey: str(),
			title: opt(str()),
			cols: opt(num()),
			rows: opt(num()),
		}),
		result: wireObj({ id: str(), created: bool(), replay: opt(str()) }),
	},
	"terminal.list": {
		params: wireObj({ workspaceId: str() }),
		result: wireObj({ tabs: arr(TerminalTabInfo) }),
	},
	"terminal.write": { params: wireObj({ id: str(), data: str() }), result: Ack },
	"terminal.resize": { params: wireObj({ id: str(), cols: num(), rows: num() }), result: Ack },
	"terminal.close": {
		params: wireObj({ workspaceId: str(), tabKey: str(), force: opt(bool()) }),
		result: wireObj({ closed: bool(), busy: bool() }),
	},
};
