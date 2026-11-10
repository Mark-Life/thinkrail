import { appendFileSync } from "node:fs";
import type { Validator } from "@earendil-works/pi-schema";
import { describeFailure, type WsMethodName, wsResultValidator } from "@thinkrail/contracts";
import { logger } from "../log";

const log = logger("wsResults");

/** Whether replies are checked: in every test run and in hosts started with `THINKRAIL_CHECK_WS_RESULTS=1`. */
export function wireChecksOn(env: Record<string, string | undefined>) {
	return env.THINKRAIL_CHECK_WS_RESULTS === "1" || env.NODE_ENV === "test";
}

const CHECKS_ON = wireChecksOn(process.env);

function checkOnWire<T>(kind: string, name: string, validator: () => Validator<T>, value: unknown) {
	if (!CHECKS_ON) return;
	const onWire: unknown = value === undefined ? undefined : JSON.parse(JSON.stringify(value));
	const check = validator();
	if (check.check(onWire)) return;
	const message = `ws ${kind} check failed: ${name}: ${describeFailure(check, onWire, kind)}`;
	log.error(message);
	const failureLog = process.env.THINKRAIL_E2E_WS_RESULT_LOG;
	if (failureLog) appendFileSync(failureLog, `${message}\n`);
	throw new Error(message);
}

/** Test harnesses only: refuses a reply whose JSON form breaks its result schema. @throws `Error` naming the method and fields. */
export function checkWsResult(method: WsMethodName, result: unknown) {
	checkOnWire("result", method, () => wsResultValidator(method), result);
}
