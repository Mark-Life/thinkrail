import { compile } from "@earendil-works/pi-schema";
import { WsEnvelope } from "@thinkrail/contracts";

const envelope = compile(WsEnvelope);

/** A host frame: its envelope, or the reply id a refused frame still names. */
export type HostFrame =
	| { readonly ok: true; readonly envelope: WsEnvelope }
	| { readonly ok: false; readonly id: string | undefined };

function idOf(value: unknown) {
	if (typeof value !== "object" || value === null || !("id" in value)) return undefined;
	return typeof value.id === "string" ? value.id : undefined;
}

export function readHostFrame(raw: string): HostFrame {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return { ok: false, id: undefined };
	}
	return envelope.check(value) ? { ok: true, envelope: value } : { ok: false, id: idOf(value) };
}
