import type { SpeechErrorCode, SpeechModel } from "./schema";

type SameUnion<A extends B, B extends C, C = A> = A;

export const SPEECH_MODELS = ["multilingual", "english"] as const satisfies readonly SpeechModel[];

export function isSpeechModel(
	value: unknown,
): value is SameUnion<SpeechModel, (typeof SPEECH_MODELS)[number]> {
	return SPEECH_MODELS.some((model) => model === value);
}

/** The host route a client upgrades to for one dictation stream at a time. */
export const SPEECH_SOCKET_ROUTE = "/speech";
/** Clients send mono little-endian PCM16 binary frames at this rate. */
export const SPEECH_SAMPLE_RATE = 16_000;

export const SPEECH_ERROR_CODES = [
	"SPEECH_UNSUPPORTED_PLATFORM",
	"SPEECH_NOT_INSTALLED",
	"SPEECH_INSTALL_BUSY",
	"SPEECH_DOWNLOAD_FAILED",
	"SPEECH_CHECKSUM_MISMATCH",
	"SPEECH_DISK_SPACE",
	"SPEECH_ENGINE_FAILED",
	"SPEECH_BUSY",
	"SPEECH_PROTOCOL",
] as const satisfies readonly SpeechErrorCode[];

export function isSpeechErrorCode(
	value: unknown,
): value is SameUnion<SpeechErrorCode, (typeof SPEECH_ERROR_CODES)[number]> {
	return SPEECH_ERROR_CODES.some((code) => code === value);
}

/**
 * Client → host over the speech socket. `start` opens one dictation; PCM16 binary frames follow;
 * `stop` commits the buffered audio and waits for the last final.
 */
export type SpeechClientMessage = { type: "start" } | { type: "stop" };

/** Host → client over the speech socket; `partial` replaces the previous partial, `final` commits it. */
export type SpeechServerMessage =
	| { type: "ready" }
	| { type: "partial"; text: string }
	| { type: "final"; text: string }
	| { type: "error"; code: SpeechErrorCode }
	| { type: "ended" };

export function parseSpeechServerMessage(raw: unknown): SpeechServerMessage | null {
	if (typeof raw !== "string") return null;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null) return null;
	const type = Reflect.get(value, "type");
	if (type === "ready" || type === "ended") return { type };
	if (type === "partial" || type === "final") {
		const text = Reflect.get(value, "text");
		return typeof text === "string" ? { type, text } : null;
	}
	if (type === "error") {
		const code = Reflect.get(value, "code");
		return isSpeechErrorCode(code) ? { type, code } : null;
	}
	return null;
}

export function parseSpeechClientMessage(raw: string): SpeechClientMessage | null {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null) return null;
	const type = Reflect.get(value, "type");
	return type === "stop" || type === "start" ? { type } : null;
}
