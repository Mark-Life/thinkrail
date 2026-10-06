import type { WsMethodName, WsParams } from "@thinkrail/contracts";
import { appHandlers } from "./app";
import { modelHandlers } from "./models";
import { projectHandlers } from "./project";
import { repoHandlers } from "./repo";
import { reviewHandlers } from "./review";
import { sessionHandlers } from "./session";
import { terminalHandlers } from "./terminal";
import { todoHandlers } from "./todo";
import type { RequestContext, WsHandlers } from "./types";
import { workspaceHandlers } from "./workspace";

export { shouldRefreshOpenReview } from "./workspace";

const handlers: WsHandlers = {
	...projectHandlers,
	...workspaceHandlers,
	...repoHandlers,
	...todoHandlers,
	...terminalHandlers,
	...sessionHandlers,
	...modelHandlers,
	...appHandlers,
	...reviewHandlers,
};

function isWsMethod(method: string): method is WsMethodName {
	return Object.hasOwn(handlers, method);
}

function dispatch<M extends WsMethodName>(method: M, params: WsParams<M>, ctx: RequestContext) {
	return handlers[method](params, ctx);
}

export function requestMethodDiagnostic(method: string): string {
	return isWsMethod(method) ? method : "unknown method";
}

export async function handleRequest(
	method: string,
	params: unknown,
	ctx: RequestContext,
): Promise<unknown> {
	if (!isWsMethod(method)) throw new Error(`Unknown method: ${method}`);
	return dispatch(method, params as WsParams<typeof method>, ctx);
}
