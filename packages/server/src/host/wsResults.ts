import { appendFileSync } from "node:fs";
import { compile } from "@earendil-works/pi-schema";
import { WS_METHOD_SCHEMAS, type WsMethodName } from "@thinkrail/contracts";
import { logger } from "../log";

const MAX_REPORTED_ERRORS = 5;

const log = logger("wsResults");

/** Test harnesses only: refuses a reply whose JSON form breaks its result schema. @throws `Error` naming the method and fields. */
export function checkWsResult(method: WsMethodName, result: unknown) {
	if (process.env.THINKRAIL_CHECK_WS_RESULTS !== "1") return;
	const onWire: unknown = result === undefined ? undefined : JSON.parse(JSON.stringify(result));
	const validator = compile(WS_METHOD_SCHEMAS[method].result);
	if (validator.check(onWire)) return;
	const reasons = validator
		.errors(onWire)
		.slice(0, MAX_REPORTED_ERRORS)
		.map((e) => `${e.path || "result"} ${e.message}`);
	const message = `ws result check failed: ${method}: ${reasons.join("; ")}`;
	log.error(message);
	const failureLog = process.env.THINKRAIL_E2E_WS_RESULT_LOG;
	if (failureLog) appendFileSync(failureLog, `${message}\n`);
	throw new Error(message);
}
