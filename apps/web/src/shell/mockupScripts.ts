import { DESKTOP_SHELL_GLOBAL, isMockupPath } from "@thinkrail/contracts";
import { strArg } from "@thinkrail/extension-api/web";
import { canonicalWorkspacePath, type ResourceHtmlMode } from "@thinkrail/resource-renderers";
import type { ChatTurn } from "../chat/types";
import { selectWorkspaceSessionIds, type useAppStore } from "../store";

const VISUALIZE_TOOL = "visualize";
const FILE_TYPE = "file";

type AppState = ReturnType<typeof useAppStore.getState>;

interface MockupTrustState
	extends Pick<
		AppState,
		"tabsByWorkspace" | "closedChatsByWorkspace" | "layoutDocumentsByWorkspace"
	> {
	sessions: Record<string, Pick<AppState["sessions"][string], "turns" | "toolResults">>;
}

interface VisualizeCall {
	id: string;
	paths: readonly string[];
}

const callsByTurns = new WeakMap<readonly ChatTurn[], readonly VisualizeCall[]>();

function visualizeCalls(turns: readonly ChatTurn[]): readonly VisualizeCall[] {
	const cached = callsByTurns.get(turns);
	if (cached) return cached;
	const calls = turns.flatMap((turn) =>
		turn.kind === "assistant"
			? turn.message.content.flatMap((block) =>
					block.type === "toolCall" &&
					block.name === VISUALIZE_TOOL &&
					strArg(block.arguments, "type") === FILE_TYPE
						? [
								{
									id: block.id,
									paths: [strArg(block.arguments, "path"), strArg(block.arguments, "before")].map(
										canonicalWorkspacePath,
									),
								},
							]
						: [],
				)
			: [],
	);
	callsByTurns.set(turns, calls);
	return calls;
}

function isShownMockup(state: MockupTrustState, workspaceId: string, path: string): boolean {
	return selectWorkspaceSessionIds(state, workspaceId).some((sessionId) => {
		const runtime = state.sessions[sessionId];
		return (
			runtime !== undefined &&
			visualizeCalls(runtime.turns).some(
				(call) => call.paths.includes(path) && runtime.toolResults[call.id]?.status === "done",
			)
		);
	});
}

export function scriptlessHtmlMode(path: string): ResourceHtmlMode {
	return isMockupPath(path) ? "themed" : "static";
}

function shellRunsMockupScripts(shell: object): boolean {
	if (!Object.hasOwn(shell, DESKTOP_SHELL_GLOBAL)) return true;
	const marker: unknown = Reflect.get(shell, DESKTOP_SHELL_GLOBAL);
	return (
		typeof marker === "object" && marker !== null && Reflect.get(marker, "mockupScripts") === true
	);
}

export function mockupHtmlMode(
	state: MockupTrustState,
	workspaceId: string,
	path: string,
	shell: object = globalThis,
): ResourceHtmlMode {
	const scriptless = scriptlessHtmlMode(path);
	if (scriptless === "static" || !shellRunsMockupScripts(shell)) return scriptless;
	return isShownMockup(state, workspaceId, path) ? "scripted" : scriptless;
}
