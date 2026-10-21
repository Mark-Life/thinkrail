export const SCENARIO_NAMES = [
	"chat-streaming",
	"region-toggles",
	"live-file-edits",
	"large-diff",
	"long-stream",
	"long-stream-xl",
	"parallel-agents",
	"background-agents",
	"plan-pane",
	"review-panel",
] as const;

export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export const DEFAULT_SCENARIOS: readonly ScenarioName[] = [
	"chat-streaming",
	"region-toggles",
	"live-file-edits",
	"large-diff",
	"plan-pane",
	"review-panel",
];

export const KEY_COMPONENTS: Partial<Record<ScenarioName, readonly string[]>> = {
	"plan-pane": ["PlanPane", "GroupSection", "ItemBlock"],
	"review-panel": ["ReviewPanel", "FileSection", "CommentRow"],
};

export function isScenarioName(name: string): name is ScenarioName {
	return (SCENARIO_NAMES as readonly string[]).includes(name);
}
