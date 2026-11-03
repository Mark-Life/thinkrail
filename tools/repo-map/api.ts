import type { GraphSide, RepoGraph } from "./core/types";
import { readSource } from "./graphs";
import type { Session } from "./session";

function jsonResponse(body: string) {
	return new Response(body, { headers: { "content-type": "application/json" } });
}

function memoize(produce: () => string) {
	let value: string | undefined;
	return () => {
		value ??= produce();
		return value;
	};
}

function parseSide(value: string | null): GraphSide | undefined {
	if (value === null || value === "head") return "head";
	return value === "base" ? "base" : undefined;
}

function badRequest(message: string, status = 400) {
	return new Response(message, { status });
}

export function createApiHandlers(session: Session) {
	const sessionJson = memoize(() => JSON.stringify(session.info));
	const headJson = memoize(() => JSON.stringify(session.head));
	const baseJson = memoize(() => JSON.stringify(session.base ?? null));
	const diffJson = memoize(() => JSON.stringify(session.diff ?? null));
	const graphFor = (side: GraphSide): RepoGraph | undefined =>
		side === "head" ? session.head : session.base;
	return {
		session: () => jsonResponse(sessionJson()),
		graph: (request: Request) => {
			const side = parseSide(new URL(request.url).searchParams.get("side"));
			if (!side) return badRequest("side must be base or head");
			if (!graphFor(side)) return badRequest("this session has no base graph", 404);
			return jsonResponse(side === "head" ? headJson() : baseJson());
		},
		diff: () =>
			session.diff ? jsonResponse(diffJson()) : badRequest("this session has no diff", 404),
		source: async (request: Request) => {
			const params = new URL(request.url).searchParams;
			const side = parseSide(params.get("side"));
			const file = params.get("file");
			if (!side) return badRequest("side must be base or head");
			if (!file) return badRequest("file is required");
			const graph = graphFor(side);
			if (!graph) return badRequest("this session has no base graph", 404);
			const text = readSource({ root: session.root, graph, file });
			if (!text) return badRequest("file is not in the graph", 403);
			return new Response(await text, { headers: { "content-type": "text/plain; charset=utf-8" } });
		},
	};
}
