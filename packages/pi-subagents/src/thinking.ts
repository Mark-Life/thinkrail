import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";

export const THINKING_LEVELS = MODEL_THINKING_LEVELS satisfies readonly ThinkingLevel[];

const levels = new Set<string>(THINKING_LEVELS);

export function isThinkingLevel(value: string): value is ThinkingLevel {
	return levels.has(value);
}
