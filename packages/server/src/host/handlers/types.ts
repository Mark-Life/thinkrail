import type { WsMethodName, WsParams, WsResult } from "@thinkrail/contracts";

export interface RequestContext {
	clientKey: string;
	runHostUpdate?: () => void;
}

type WsHandler<M extends WsMethodName> = (
	params: WsParams<M>,
	ctx: RequestContext,
) => WsResult<M> | Promise<WsResult<M>>;

export type WsHandlers = { [M in WsMethodName]: WsHandler<M> };

export type HandlersFor<P extends string> = {
	[M in WsMethodName as M extends `${P}.${string}` ? M : never]: WsHandler<M>;
};
