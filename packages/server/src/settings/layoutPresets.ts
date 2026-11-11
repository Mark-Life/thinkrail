import { compile } from "@earendil-works/pi-schema";
import {
	JsonObject,
	LayoutPreset,
	type LayoutPresetBottomRegion,
	type LayoutPresetSideGroup,
	type LayoutPresetSideRegion,
	type LayoutToolId,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";

const MAX_PRESETS = 32;
const MAX_LAYOUT_BYTES = 512 * 1024;
const MAX_CENTER_GROUPS = 4;
const MAX_GROUPS = 32;
const MAX_DEPTH = 8;
const MAX_NAME_LENGTH = 200;
const MAX_BOTTOM_HEIGHT = 0.7;
const LayoutPresetShape = compile(LayoutPreset);

class LayoutPresetRuleError extends CodedError {
	readonly rule: string;

	constructor(rule: string, detail?: string) {
		super("INVALID_PARAMS", detail === undefined ? rule : `${rule}: ${detail}`);
		this.rule = rule;
	}
}

function record(value: unknown): Record<string, unknown> | null {
	return JsonObject.check(value) ? value : null;
}

function nonEmptyString(value: unknown, max = MAX_NAME_LENGTH): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}

function positive(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function assertKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	label: string,
): void {
	const known = new Set(allowed);
	const extra = Object.keys(value).find((key) => !known.has(key));
	if (extra) throw new LayoutPresetRuleError(`${label} has an unknown field`, extra);
}

function exceedsBudget(value: unknown): boolean {
	try {
		return new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_LAYOUT_BYTES;
	} catch {
		return true;
	}
}

function validateCenter(value: unknown, depth: number, ids: Set<string>): number {
	const node = record(value);
	if (!node || !nonEmptyString(node.id) || (node.kind !== "group" && node.kind !== "split")) {
		throw new LayoutPresetRuleError("Malformed layout preset center");
	}
	if (ids.has(node.id)) throw new LayoutPresetRuleError("Duplicate preset node id", node.id);
	ids.add(node.id);
	if (depth > MAX_DEPTH) throw new LayoutPresetRuleError("Layout preset center is too deep");
	if (node.kind === "group") {
		assertKeys(node, ["kind", "id"], "Preset center group");
		return 1;
	}
	assertKeys(node, ["kind", "id", "direction", "weights", "children"], "Preset center split");
	if (
		(node.direction !== "horizontal" && node.direction !== "vertical") ||
		!Array.isArray(node.weights) ||
		node.weights.length !== 2 ||
		!positive(node.weights[0]) ||
		!positive(node.weights[1]) ||
		Math.abs(node.weights[0] + node.weights[1] - 1) > 1e-6 ||
		!Array.isArray(node.children) ||
		node.children.length !== 2
	) {
		throw new LayoutPresetRuleError("Malformed layout preset split");
	}
	return (
		validateCenter(node.children[0], depth + 1, ids) +
		validateCenter(node.children[1], depth + 1, ids)
	);
}

function validateGroups(
	groups: readonly LayoutPresetSideGroup[],
	ids: Set<string>,
	tools: Set<LayoutToolId>,
	label: string,
): void {
	if (groups.length > MAX_GROUPS)
		throw new LayoutPresetRuleError(`Malformed preset ${label} groups`);
	let total = 0;
	for (const group of groups) {
		if (!nonEmptyString(group.id) || !positive(group.weight)) {
			throw new LayoutPresetRuleError(`Malformed preset ${label} group`);
		}
		assertKeys(group, ["id", "weight", "folded", "tools"], `Preset ${label} group`);
		if (ids.has(group.id)) throw new LayoutPresetRuleError("Duplicate preset node id", group.id);
		ids.add(group.id);
		total += group.weight;
		for (const tool of group.tools) {
			if (tools.has(tool)) throw new LayoutPresetRuleError("Duplicate preset singleton tool", tool);
			tools.add(tool);
		}
	}
	if (groups.length > 0 && Math.abs(total - 1) > 1e-6) {
		throw new LayoutPresetRuleError(`Preset ${label} group weights are not normalized`);
	}
}

function validateSide(
	region: LayoutPresetSideRegion | LayoutPresetBottomRegion,
	label: string,
	ids: Set<string>,
	tools: Set<LayoutToolId>,
): void {
	if (region.visible && region.groups.length === 0) {
		throw new LayoutPresetRuleError(`Preset ${label} cannot be visible while empty`);
	}
	validateGroups(region.groups, ids, tools, label);
}

export function validateLayoutPreset(value: unknown): LayoutPreset {
	if (exceedsBudget(value)) throw new LayoutPresetRuleError("Layout preset is too large");
	const preset = record(value);
	if (!preset || !nonEmptyString(preset.id) || !nonEmptyString(preset.name)) {
		throw new LayoutPresetRuleError("Malformed layout preset");
	}
	assertKeys(preset, ["id", "name", "center", "left", "right", "bottom"], "Layout preset");
	const ids = new Set<string>();
	if (validateCenter(preset.center, 1, ids) > MAX_CENTER_GROUPS) {
		throw new LayoutPresetRuleError("Layout preset has too many center groups");
	}
	if (!LayoutPresetShape.check(value)) {
		throw new LayoutPresetRuleError(
			`Malformed layout preset at ${LayoutPresetShape.errors(value)[0]?.path}`,
		);
	}
	const { left, right, bottom } = value;
	const tools = new Set<LayoutToolId>();
	for (const [side, region] of [
		["left", left],
		["right", right],
	] as const) {
		assertKeys(region, ["visible", "width", "groups"], `Preset ${side} side`);
		if (!positive(region.width) || region.width >= 1) {
			throw new LayoutPresetRuleError(`Malformed preset ${side} side`);
		}
		validateSide(region, `${side} side`, ids, tools);
	}
	assertKeys(bottom, ["visible", "height", "alignment", "groups"], "Preset bottom region");
	if (!positive(bottom.height) || bottom.height > MAX_BOTTOM_HEIGHT) {
		throw new LayoutPresetRuleError("Malformed preset bottom region");
	}
	validateSide(bottom, "bottom region", ids, tools);
	if (left.width + right.width >= 1)
		throw new LayoutPresetRuleError("Preset side widths leave no center region");
	return value;
}

export function validateCustomLayoutPresets(value: unknown): LayoutPreset[] {
	if (exceedsBudget(value) || !Array.isArray(value) || value.length > MAX_PRESETS) {
		throw new LayoutPresetRuleError("Invalid custom layout presets");
	}
	const presets = value.map(validateLayoutPreset);
	if (new Set(presets.map((preset) => preset.id)).size !== presets.length) {
		throw new LayoutPresetRuleError("Custom layout preset ids must be unique");
	}
	return presets;
}

function storedPresetProblem(
	candidate: LayoutPreset,
	kept: readonly LayoutPreset[],
): string | null {
	if (kept.length >= MAX_PRESETS) return "is past the preset limit";
	if (kept.some((preset) => preset.id === candidate.id)) return "repeats a preset id";
	try {
		validateLayoutPreset(candidate);
		return null;
	} catch (error) {
		if (!(error instanceof LayoutPresetRuleError)) throw error;
		return `breaks a preset rule: ${error.rule}`;
	}
}

/** Stored presets passed the schema at the read; this applies the catalog rules and names each drop. */
export function keepValidStoredPresets(stored: readonly LayoutPreset[]) {
	const presets: LayoutPreset[] = [];
	const dropped: string[] = [];
	for (const [index, candidate] of stored.entries()) {
		const problem = storedPresetProblem(candidate, presets);
		if (problem) dropped.push(`${index} ${problem}`);
		else presets.push(candidate);
	}
	return { presets, dropped };
}
