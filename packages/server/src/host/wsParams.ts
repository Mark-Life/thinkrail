import { compile } from "@earendil-works/pi-schema";
import { WS_METHOD_SCHEMAS, type WsMethodName, type WsParams } from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";

const MAX_REPORTED_ERRORS = 5;

const validators = new Map(
	Object.entries(WS_METHOD_SCHEMAS).map(([method, { params }]) => [method, compile(params)]),
);

/** Checks a request's params before its handler runs. @throws `CodedError` `INVALID_PARAMS`. */
export function parseWsParams<M extends WsMethodName>(method: M, raw: unknown): WsParams<M> {
	const validator = validators.get(method);
	if (validator && !validator.check(raw)) {
		const reasons = validator
			.errors(raw)
			.slice(0, MAX_REPORTED_ERRORS)
			.map((e) => `${e.path || "params"} ${e.message}`);
		throw new CodedError("INVALID_PARAMS", `Invalid ${method}: ${reasons.join("; ")}`);
	}
	return raw as WsParams<M>;
}
