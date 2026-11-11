import {
	arr,
	bool,
	int,
	map,
	num,
	obj,
	oneOf,
	opt,
	type Static,
	str,
} from "@earendil-works/pi-schema";

export const FIELDS = {
	id: "id",
	type: "type",
	status: "status",
	title: "title",
	parent: "parent",
	dependsOn: "depends-on",
	references: "references",
	implements: "implements",
	covers: "covers",
	tags: "tags",
} as const;

export const SPEC_TYPES = [
	"goal-and-requirements",
	"architecture-design",
	"module-design",
	"submodule-design",
	"task-spec",
] as const;

export const SPEC_STATUSES = ["draft", "active", "stale", "done", "deprecated"] as const;

export const SINGLE_LINK_FIELDS = [FIELDS.parent] as const;

export const LIST_LINK_FIELDS = [FIELDS.dependsOn, FIELDS.references, FIELDS.implements] as const;

export const LINK_KINDS = [...SINGLE_LINK_FIELDS, ...LIST_LINK_FIELDS] as const;

export const SLICE_DIRECTIONS = ["subtree", "ancestors", "neighbors"] as const;

export const DEFAULT_GREP_LIMIT = 200;

function strEnum<const V extends readonly string[]>(values: V, description: string) {
	return { ...oneOf(values, { description }), type: "string" };
}

const open = { open: true } as const;

/** The `spec_grep` tool's arguments. */
export const SpecGrepInput = obj(
	{
		pattern: str({ description: "Regex or substring to search for within spec files." }),
		regex: opt(
			bool({ description: "Treat pattern as a regular expression (default: substring)." }),
		),
		ignoreCase: opt(bool({ description: "Case-insensitive match (default: true)." })),
		type: opt(str({ description: "Only search specs with this frontmatter type." })),
		tag: opt(str({ description: "Only search specs carrying this tag." })),
		parent: opt(str({ description: "Only search specs whose parent is this id." })),
		dependsOn: opt(str({ description: "Only search specs that depend-on this id." })),
		limit: opt(
			int({
				minimum: 1,
				description: `Matches per page (default/max: ${DEFAULT_GREP_LIMIT}; the byte limit may return fewer).`,
			}),
		),
		offset: opt(
			int({
				minimum: 0,
				description:
					"Zero-based match offset (default: 0). Continue with the offset given in the result and the same filters; restart after source changes.",
			}),
		),
	},
	open,
);
export type SpecGrepInput = Static<typeof SpecGrepInput>;

/** The `spec_graph` tool's arguments. */
export const SpecGraphInput = obj(
	{
		root: str({ description: "Id of the node to start from." }),
		direction: strEnum(
			SLICE_DIRECTIONS,
			"subtree = down the parent tree; ancestors = up the parent chain; neighbors = across an edge and its reverse.",
		),
		depth: opt(num({ description: "How many hops to expand (default: 1)." })),
		edge: opt(
			strEnum(
				LINK_KINDS,
				"For direction=neighbors: which edge kind to traverse (default: depends-on).",
			),
		),
	},
	open,
);
export type SpecGraphInput = Static<typeof SpecGraphInput>;

/** The `spec_create` tool's arguments. */
export const SpecCreateInput = obj(
	{
		path: str({
			description:
				"Root-relative path for the new spec file, ending in .md (e.g. src/foo/SPEC.md). Must stay inside the project root.",
		}),
		id: str({ description: "Unique spec id." }),
		type: strEnum(
			SPEC_TYPES,
			"Spec type: goal-and-requirements | architecture-design | module-design | submodule-design | task-spec.",
		),
		title: str({ description: "Human-readable title." }),
		status: opt(
			strEnum(SPEC_STATUSES, "Lifecycle status: draft | active | stale | done | deprecated."),
		),
		parent: opt(str({ description: "Parent id (the tree edge)." })),
		dependsOn: opt(arr(str(), { description: "depends-on link ids." })),
		references: opt(arr(str(), { description: "references link ids." })),
		implements: opt(arr(str(), { description: "implements link ids." })),
		covers: opt(arr(str(), { description: "covers ids." })),
		tags: opt(arr(str(), { description: "tags." })),
	},
	open,
);
export type SpecCreateInput = Static<typeof SpecCreateInput>;

/** The `spec_get` tool's arguments. */
export const SpecGetInput = obj({ id: str({ description: "The spec id to look up." }) }, open);
export type SpecGetInput = Static<typeof SpecGetInput>;

const ListGroup = obj(
	{
		[FIELDS.dependsOn]: opt(arr(str())),
		[FIELDS.references]: opt(arr(str())),
		[FIELDS.implements]: opt(arr(str())),
		[FIELDS.covers]: opt(arr(str())),
		[FIELDS.tags]: opt(arr(str())),
	},
	open,
);

/** The `spec_update` tool's arguments. */
export const SpecUpdateInput = obj(
	{
		id: str({ description: "Id of the spec to update." }),
		set: opt(
			map(str(), {
				description:
					"Scalar frontmatter fields to set/overwrite (e.g. title, status, parent). For list fields (depends-on/references/implements/covers/tags) use addList/removeList.",
			}),
		),
		remove: opt(arr(str(), { description: "Frontmatter field names to remove entirely." })),
		addList: opt(ListGroup),
		removeList: opt(ListGroup),
	},
	open,
);
export type SpecUpdateInput = Static<typeof SpecUpdateInput>;

/** The `spec_delete` tool's arguments. */
export const SpecDeleteInput = obj({ id: str({ description: "Id of the spec to delete." }) }, open);
export type SpecDeleteInput = Static<typeof SpecDeleteInput>;
