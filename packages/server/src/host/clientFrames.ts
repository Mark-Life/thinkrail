import { compile } from "@earendil-works/pi-schema";
import { WsAck, WsRequestFrame, WsResume } from "@thinkrail/contracts";

const ack = compile(WsAck);
const resume = compile(WsResume);
const request = compile(WsRequestFrame);

function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

/** Reads one client frame. A receipt wins over a request on a frame that is both. */
export function readClientFrame(raw: string) {
	const frame = parseJson(raw);
	if (ack.check(frame)) return { kind: "ack", ids: frame.ack } as const;
	if (resume.check(frame)) return { kind: "resume", ids: frame.resume } as const;
	if (request.check(frame)) return { kind: "request", request: frame } as const;
	return { kind: "refused" } as const;
}
