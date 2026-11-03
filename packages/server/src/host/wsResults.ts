import { appendFileSync } from "node:fs";
import { compile, type Schema } from "@earendil-works/pi-schema";
import {
	WS_CHANNEL_SCHEMAS,
	WS_METHOD_SCHEMAS,
	type WsChannel,
	type WsChannelPayload,
	type WsMethodName,
} from "@thinkrail/contracts";
import { logger } from "../log";

const MAX_REPORTED_ERRORS = 5;

const log = logger("wsResults");

function checkOnWire(kind: string, name: string, schema: Schema<unknown>, value: unknown) {
	if (process.env.THINKRAIL_CHECK_WS_RESULTS !== "1") return;
	const onWire: unknown = value === undefined ? undefined : JSON.parse(JSON.stringify(value));
	const validator = compile(schema);
	if (validator.check(onWire)) return;
	const reasons = validator
		.errors(onWire)
		.slice(0, MAX_REPORTED_ERRORS)
		.map((e) => `${e.path || kind} ${e.message}`);
	const message = `ws ${kind} check failed: ${name}: ${reasons.join("; ")}`;
	log.error(message);
	const failureLog = process.env.THINKRAIL_E2E_WS_RESULT_LOG;
	if (failureLog) appendFileSync(failureLog, `${message}\n`);
	throw new Error(message);
}

/** Test harnesses only: refuses a reply whose JSON form breaks its result schema. @throws `Error` naming the method and fields. */
export function checkWsResult(method: WsMethodName, result: unknown) {
	checkOnWire("result", method, WS_METHOD_SCHEMAS[method].result, result);
}

/** Test harnesses only: refuses a push whose JSON form breaks its channel schema. @throws `Error` naming the channel and fields. */
export function checkWsPush(channel: WsChannel, data: unknown) {
	checkOnWire("push", channel, WS_CHANNEL_SCHEMAS[channel], data);
}

export function pushFrame<C extends WsChannel>(channel: C, data: WsChannelPayload<C>) {
	checkWsPush(channel, data);
	return JSON.stringify({ channel, data });
}
