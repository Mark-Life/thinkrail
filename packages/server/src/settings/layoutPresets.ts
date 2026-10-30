import type { LayoutPreset, LayoutPresetCenterNode } from "@thinkrail/contracts";
import { Type } from "typebox";
import { Check } from "typebox/value";

const MAX_PRESETS = 32;
const MAX_LAYOUT_BYTES = 512 * 1024;
const MAX_CENTER_GROUPS = 4;
const MAX_GROUPS = 32;
const MAX_DEPTH = 8;
const MAX_NAME_LENGTH = 200;
const MAX_BOTTOM_HEIGHT = 0.7;

const Name = Type.String({ minLength: 1, maxLength: MAX_NAME_LENGTH });
const Weight = Type.Number({ exclusiveMinimum: 0 });
const ToolId = Type.Union([
	Type.Literal("projects"),
	Type.Literal("specs"),
	Type.Literal("files"),
	Type.Literal("review"),
	Type.Literal("plan"),
]);

const CenterNodeSchema = Type.Cyclic(
	{
		Node: Type.Union([
			Type.Object({ kind: Type.Literal("group"), id: Name }, { additionalProperties: false }),
			Type.Object(
				{
					kind: Type.Literal("split"),
					id: Name,
					direction: Type.Union([Type.Literal("horizontal"), Type.Literal("vertical")]),
					weights: Type.Tuple([Weight, Weight]),
					children: Type.Tuple([Type.Ref("Node"), Type.Ref("Node")]),
				},
				{ additionalProperties: false },
			),
		]),
	},
	"Node",
);

const GroupSchema = Type.Object(
	{ id: Name, weight: Weight, folded: Type.Boolean(), tools: Type.Array(ToolId) },
	{ additionalProperties: false },
);

const SideSchema = Type.Object(
	{
		visible: Type.Boolean(),
		width: Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1 }),
		groups: Type.Array(GroupSchema, { maxItems: MAX_GROUPS }),
	},
	{ additionalProperties: false },
);

const BottomSchema = Type.Object(
	{
		visible: Type.Boolean(),
		height: Type.Number({ exclusiveMinimum: 0, maximum: MAX_BOTTOM_HEIGHT }),
		alignment: Type.Union([
			Type.Literal("center"),
			Type.Literal("center-left"),
			Type.Literal("center-right"),
			Type.Literal("full"),
		]),
		groups: Type.Array(GroupSchema, { maxItems: MAX_GROUPS }),
	},
	{ additionalProperties: false },
);

const LayoutPresetSchema = Type.Object(
	{
		id: Name,
		name: Name,
		center: CenterNodeSchema,
		left: SideSchema,
		right: SideSchema,
		bottom: BottomSchema,
	},
	{ additionalProperties: false },
);

function exceedsBudget(value: unknown): boolean {
	try {
		return new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_LAYOUT_BYTES;
	} catch {
		return true;
	}
}

function checkCenter(node: LayoutPresetCenterNode, depth: number, ids: Set<string>): number {
	if (ids.has(node.id)) throw new Error(`Duplicate preset node id: ${node.id}`);
	ids.add(node.id);
	if (depth > MAX_DEPTH) throw new Error("Layout preset center is too deep");
	if (node.kind === "group") return 1;
	if (Math.abs(node.weights[0] + node.weights[1] - 1) > 1e-6) {
		throw new Error("Malformed layout preset split");
	}
	return (
		checkCenter(node.children[0], depth + 1, ids) + checkCenter(node.children[1], depth + 1, ids)
	);
}

function checkGroups(
	groups: LayoutPreset["bottom"]["groups"],
	ids: Set<string>,
	tools: Set<string>,
	label: string,
): void {
	let total = 0;
	for (const group of groups) {
		if (ids.has(group.id)) throw new Error(`Duplicate preset node id: ${group.id}`);
		ids.add(group.id);
		total += group.weight;
		for (const tool of group.tools) {
			if (tools.has(tool)) throw new Error(`Duplicate preset singleton tool: ${tool}`);
			tools.add(tool);
		}
	}
	if (groups.length > 0 && Math.abs(total - 1) > 1e-6) {
		throw new Error(`Preset ${label} group weights are not normalized`);
	}
}

export function validateLayoutPreset(value: unknown): LayoutPreset {
	if (exceedsBudget(value)) throw new Error("Layout preset is too large");
	if (!Check(LayoutPresetSchema, value)) throw new Error("Malformed layout preset");
	const ids = new Set<string>();
	if (checkCenter(value.center, 1, ids) > MAX_CENTER_GROUPS) {
		throw new Error("Layout preset has too many center groups");
	}
	const tools = new Set<string>();
	for (const side of ["left", "right"] as const) {
		if (value[side].visible && value[side].groups.length === 0) {
			throw new Error(`Preset ${side} side cannot be visible while empty`);
		}
		checkGroups(value[side].groups, ids, tools, `${side} side`);
	}
	if (value.bottom.visible && value.bottom.groups.length === 0) {
		throw new Error("Preset bottom region cannot be visible without a group");
	}
	checkGroups(value.bottom.groups, ids, tools, "bottom");
	if (value.left.width + value.right.width >= 1) {
		throw new Error("Preset side widths leave no center region");
	}
	return value;
}

export function validateCustomLayoutPresets(value: unknown): LayoutPreset[] {
	if (exceedsBudget(value) || !Array.isArray(value) || value.length > MAX_PRESETS) {
		throw new Error("Invalid custom layout presets");
	}
	const presets = value.map(validateLayoutPreset);
	if (new Set(presets.map((preset) => preset.id)).size !== presets.length) {
		throw new Error("Custom layout preset ids must be unique");
	}
	return presets;
}

export function normalizeStoredCustomLayoutPresets(value: unknown): LayoutPreset[] {
	if (!Array.isArray(value)) return [];
	const presets: LayoutPreset[] = [];
	const ids = new Set<string>();
	for (const candidate of value.slice(0, MAX_PRESETS)) {
		try {
			const preset = validateLayoutPreset(candidate);
			if (ids.has(preset.id)) continue;
			ids.add(preset.id);
			presets.push(preset);
		} catch {}
	}
	return presets;
}
