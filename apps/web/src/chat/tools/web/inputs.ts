/**
 * The `pi-web-access` tool arguments the cards read. The package declares its tool parameters inline and
 * exports no type for them, so these are untied: the `web-access` extension SPEC lists them for review on
 * a version bump.
 */
export interface WebSearchInput {
	query?: string;
	queries?: string[];
}

export interface FetchContentInput {
	url?: string;
	urls?: string[];
}

export interface GetSearchContentInput {
	responseId: string;
	query?: string;
	queryIndex?: number;
	url?: string;
	urlIndex?: number;
}
