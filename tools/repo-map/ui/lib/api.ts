import type { GraphDiff, GraphSide, RepoGraph, SessionInfo } from "../../core/types";

class ApiError extends Error {
	readonly status: number;

	constructor(input: { status: number; message: string }) {
		super(input.message);
		this.status = input.status;
	}
}

export interface LoadProgress {
	label: string;
	loaded: number;
	total: number;
}

async function readBody(input: {
	response: Response;
	label: string;
	onProgress: (progress: LoadProgress) => void;
}) {
	const { response, label, onProgress } = input;
	const total = Number(response.headers.get("content-length") ?? 0);
	const reader = response.body?.getReader();
	if (!reader) return response.text();
	const decoder = new TextDecoder();
	let text = "";
	let loaded = 0;
	for (let read = await reader.read(); !read.done; read = await reader.read()) {
		text += decoder.decode(read.value, { stream: true });
		loaded += read.value.byteLength;
		onProgress({ label, loaded, total });
	}
	return text + decoder.decode();
}

async function fetchChecked(url: string, signal?: AbortSignal) {
	const response = await fetch(url, signal ? { signal } : {});
	if (!response.ok) {
		throw new ApiError({ status: response.status, message: await response.text() });
	}
	return response;
}

async function fetchJson<T>(input: {
	url: string;
	label: string;
	onProgress: (progress: LoadProgress) => void;
	signal: AbortSignal;
}): Promise<T> {
	const response = await fetchChecked(input.url, input.signal);
	const text = await readBody({ response, label: input.label, onProgress: input.onProgress });
	return JSON.parse(text);
}

interface LoadedData {
	session: SessionInfo;
	head: RepoGraph;
	base?: RepoGraph;
	diff?: GraphDiff;
}

export async function loadData(input: {
	onProgress: (progress: LoadProgress) => void;
	signal: AbortSignal;
}) {
	const { onProgress, signal } = input;
	const session = await fetchJson<SessionInfo>({
		url: "/api/session",
		label: "Session",
		onProgress,
		signal,
	});
	const head = await fetchJson<RepoGraph>({
		url: "/api/graph?side=head",
		label: session.mode === "diff" ? "Head graph" : "Symbol graph",
		onProgress,
		signal,
	});
	if (session.mode !== "diff") {
		const data: LoadedData = { session, head };
		return data;
	}
	const base = await fetchJson<RepoGraph>({
		url: "/api/graph?side=base",
		label: "Base graph",
		onProgress,
		signal,
	});
	const diff = await fetchJson<GraphDiff>({ url: "/api/diff", label: "Diff", onProgress, signal });
	const data: LoadedData = { session, head, base, diff };
	return data;
}

const sources = new Map<string, Promise<string>>();

export function fetchSource(input: { side: GraphSide; file: string }) {
	const key = `${input.side}:${input.file}`;
	const existing = sources.get(key);
	if (existing) return existing;
	const params = new URLSearchParams({ side: input.side, file: input.file });
	const pending = fetchChecked(`/api/source?${params}`).then((response) => response.text());
	sources.set(key, pending);
	pending.catch(() => sources.delete(key));
	return pending;
}

export function describeLoadError(error: unknown) {
	if (error instanceof ApiError) {
		return {
			title: `The server returned an error (${error.status})`,
			detail: error.message,
		};
	}
	if (error instanceof SyntaxError) {
		return { title: "The server sent data that could not be read", detail: error.message };
	}
	return {
		title: "The repo-map server is not reachable",
		detail: "Start it again with bun run repo-map, then retry.",
	};
}
