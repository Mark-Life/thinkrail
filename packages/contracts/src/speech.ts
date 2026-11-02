import { compile } from "@earendil-works/pi-schema";
import {
	SpeechClientMessage,
	type SpeechErrorCode,
	type SpeechModel,
	SpeechServerMessage,
} from "./schema";

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

const clientMessage = compile(SpeechClientMessage);
const serverMessage = compile(SpeechServerMessage);

function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

export function parseSpeechServerMessage(raw: unknown): SpeechServerMessage | null {
	if (typeof raw !== "string") return null;
	const value = parseJson(raw);
	return serverMessage.check(value) ? value : null;
}

export function parseSpeechClientMessage(raw: string): SpeechClientMessage | null {
	const value = parseJson(raw);
	return clientMessage.check(value) ? value : null;
}
