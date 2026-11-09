import type { Schema } from "@earendil-works/pi-schema";
import { WS_CHANNEL_SCHEMAS, WS_CHANNELS, WS_METHOD_SCHEMAS } from "@thinkrail/contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function closeChild(child: unknown): unknown {
	if (Array.isArray(child)) return child.map(closeChild);
	return isRecord(child) ? closedSchema(child) : child;
}

export function closedSchema(schema: Schema): Schema {
	const closed: Record<string, unknown> = { ...schema };
	if (isRecord(schema.properties)) {
		closed.properties = Object.fromEntries(
			Object.entries(schema.properties).map(([name, child]) => [name, closeChild(child)]),
		);
		closed.additionalProperties = false;
	}
	for (const keyword of ["additionalProperties", "items", "anyOf"]) {
		if (keyword in schema) closed[keyword] = closeChild(schema[keyword]);
	}
	return closed;
}

export function closeWireSchemas() {
	for (const entry of Object.values(WS_METHOD_SCHEMAS)) {
		Reflect.set(entry, "result", closedSchema(entry.result));
	}
	for (const [channel, schema] of Object.entries(WS_CHANNEL_SCHEMAS)) {
		if (channel === WS_CHANNELS.piEvent) continue;
		Reflect.set(WS_CHANNEL_SCHEMAS, channel, closedSchema(schema));
	}
}
