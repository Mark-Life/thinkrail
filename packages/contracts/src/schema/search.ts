import {
	arr,
	bool,
	lit,
	map,
	num,
	oneOf,
	opt,
	type Static,
	str,
	tuple,
	union,
} from "@earendil-works/pi-schema";
import { ProjectId, SessionId, WorkspaceId } from "./ids";
import { wireObj } from "./wire";

export const SearchKind = oneOf(["transcript", "file", "spec", "plan"]);
export type SearchKind = Static<typeof SearchKind>;

/** The shared matcher's tiers, best first; `MATCH_TIER` names them. */
export const MatchTier = oneOf([0, 1, 2, 3, 4, 5]);
export type MatchTier = Static<typeof MatchTier>;

/** Where the palette is: the active workspace, else the context project's folder, is the one root files and specs are searched in. */
export const SearchContext = wireObj({ projectId: opt(ProjectId), workspaceId: opt(WorkspaceId) });
export type SearchContext = Static<typeof SearchContext>;

const SEARCH_HIT_BASE = {
	/** `kind:id[:locator]` — stable across replies so the client can keep a selection. */
	id: str(),
	title: str(),
	subtitle: opt(str()),
	/** The shared matcher's tier and score; the client merges host hits with its own by these. */
	tier: MatchTier,
	score: num(),
	ranges: opt(map(arr(tuple([num(), num()])))),
	projectId: ProjectId,
	workspaceId: WorkspaceId,
};

export const SearchHit = union([
	/** A root-relative POSIX `path`; `size` is the bytes on disk when the host could read them. */
	wireObj({ ...SEARCH_HIT_BASE, kind: lit("file"), path: str(), size: opt(num()) }),
	/** `snippet` is the body line a `content`-tier hit matched. */
	wireObj({
		...SEARCH_HIT_BASE,
		kind: lit("spec"),
		path: str(),
		specId: str(),
		size: num(),
		snippet: opt(str()),
	}),
	wireObj({ ...SEARCH_HIT_BASE, kind: lit("plan"), sessionId: SessionId }),
	/** `anchorText` re-finds the message when compaction moved `messageIndex`. */
	wireObj({
		...SEARCH_HIT_BASE,
		kind: lit("transcript"),
		sessionId: SessionId,
		messageIndex: num(),
		anchorText: str(),
	}),
]);
export type SearchHit = Static<typeof SearchHit>;

/** `indexing`: never loaded yet; `refreshing`: a reload runs behind these hits; `failed`: the last load failed (its last good hits stay). */
export const SearchGroupState = oneOf(["ready", "indexing", "refreshing", "failed"]);
export type SearchGroupState = Static<typeof SearchGroupState>;

/** Why a group may miss hits: the scan ran out of time, or only `fileList` files of the root are listed. */
export const SearchGroupCut = wireObj({ time: opt(lit(true)), fileList: opt(num()) });
export type SearchGroupCut = Static<typeof SearchGroupCut>;

export const SearchGroup = wireObj({
	kind: SearchKind,
	hits: arr(SearchHit),
	total: num(),
	state: SearchGroupState,
	cut: opt(SearchGroupCut),
});
export type SearchGroup = Static<typeof SearchGroup>;

export const SearchQueryResult = wireObj({ groups: arr(SearchGroup) });
export type SearchQueryResult = Static<typeof SearchQueryResult>;

/** The transcript window around a chat hit; files and specs render client-side through `fs.readFile`. */
export const SearchPreviewTarget = wireObj({
	kind: lit("chat"),
	sessionId: SessionId,
	messageIndex: opt(num()),
	/** The hit's `anchorText`: the focus moves to the message it starts when compaction shifted the index. */
	anchorText: opt(str()),
});
export type SearchPreviewTarget = Static<typeof SearchPreviewTarget>;

export const SearchPreviewMessage = wireObj({
	role: oneOf(["user", "assistant"]),
	messageIndex: num(),
	text: str(),
	focus: bool(),
});
export type SearchPreviewMessage = Static<typeof SearchPreviewMessage>;

export const SearchPreviewResult = union([
	wireObj({ kind: lit("transcript"), title: str(), messages: arr(SearchPreviewMessage) }),
	wireObj({ kind: lit("unavailable") }),
]);
export type SearchPreviewResult = Static<typeof SearchPreviewResult>;

export const SEARCH_METHODS = {
	"search.query": {
		params: wireObj({
			query: str(),
			kinds: opt(arr(SearchKind)),
			context: SearchContext,
			limit: opt(num()),
		}),
		result: SearchQueryResult,
	},
	"search.preview": { params: SearchPreviewTarget, result: SearchPreviewResult },
};
