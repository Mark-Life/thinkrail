import { compile } from "@earendil-works/pi-schema";
import {
	SPEECH_ERROR_CODES,
	SPEECH_MODELS,
	SpeechClientMessage,
	type SpeechErrorCode,
	type SpeechModel,
	SpeechServerMessage,
} from "./schema";

export function isSpeechModel(value: unknown): value is SpeechModel {
	return SPEECH_MODELS.some((model) => model === value);
}

/** The host route a client upgrades to for one dictation stream at a time. */
export const SPEECH_SOCKET_ROUTE = "/speech";
/** Clients send mono little-endian PCM16 binary frames at this rate. */
export const SPEECH_SAMPLE_RATE = 16_000;

export function isSpeechErrorCode(value: unknown): value is SpeechErrorCode {
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
