import { spyOn } from "bun:test";
import {
	parseWsResult,
	type WsMethodName,
	type WsParams,
	type WsResult,
} from "@thinkrail/contracts";
import { WsTransport } from "./transport";

export interface FakeRequest {
	readonly method: WsMethodName;
	readonly params: unknown;
}

/** A transport that answers each request through `reply`, checked against the method's result schema. */
export function fakeTransport(
	reply: (method: WsMethodName, params: unknown) => unknown,
	requests: FakeRequest[] = [],
): WsTransport {
	const transport = new WsTransport({ url: "ws://localhost/ws" });
	const request = async <M extends WsMethodName>(
		method: M,
		params: WsParams<M>,
	): Promise<WsResult<M>> => {
		requests.push({ method, params });
		const parsed = parseWsResult(method, await reply(method, params));
		if (!parsed.ok) throw new Error(parsed.problem);
		return parsed.value;
	};
	spyOn(transport, "request").mockImplementation(request);
	return transport;
}
