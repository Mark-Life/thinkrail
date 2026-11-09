import { compile, type Schema } from "@earendil-works/pi-schema";
import {
	AnyHostWelcome,
	validatorOf,
	WS_CHANNEL_SCHEMAS,
	WS_CHANNELS,
	WS_METHOD_SCHEMAS,
	WsEnvelope,
	type WsMethodName,
} from "@thinkrail/contracts";

const MAX_REPORTED_ERRORS = 5;

const envelope = compile(WsEnvelope);

const CHANNEL_SCHEMAS = new Map<string, Schema<unknown>>([
	...Object.entries(WS_CHANNEL_SCHEMAS),
	[WS_CHANNELS.serverWelcome, AnyHostWelcome],
]);

function failureOf(schema: Schema<unknown>, value: unknown): string | null {
	const validator = validatorOf(schema);
	if (validator.check(value)) return null;
	return validator
		.errors(value)
		.slice(0, MAX_REPORTED_ERRORS)
		.map((error) => `${error.path} ${error.message}`)
		.join("; ");
}

export function parseEnvelope(raw: string): WsEnvelope | null {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	return envelope.check(value) ? value : null;
}

export function pushFailure(channel: string, data: unknown): string | null {
	const schema = CHANNEL_SCHEMAS.get(channel);
	return schema ? failureOf(schema, data) : "unknown channel";
}

export function resultFailure(method: WsMethodName, result: unknown): string | null {
	return failureOf(WS_METHOD_SCHEMAS[method].result, result);
}
