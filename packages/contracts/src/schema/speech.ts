import {
	bool,
	lit,
	nullable,
	num,
	oneOf,
	type Schema,
	type Static,
	str,
	union,
} from "@earendil-works/pi-schema";
import { Ack, NoParams, wireObj } from "./wire";

export const SPEECH_MODELS = ["multilingual", "english"] as const;
export const SpeechModel = oneOf(SPEECH_MODELS);
export type SpeechModel = Static<typeof SpeechModel>;

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
] as const;
export const SpeechErrorCode = oneOf(SPEECH_ERROR_CODES);
export type SpeechErrorCode = Static<typeof SpeechErrorCode>;

export const SpeechInstallPhase = oneOf(["runtime", "model"]);
export type SpeechInstallPhase = Static<typeof SpeechInstallPhase>;

export const SpeechInstallState = union([
	wireObj({ status: lit("not-installed") }),
	wireObj({
		status: lit("installing"),
		model: SpeechModel,
		phase: SpeechInstallPhase,
		receivedBytes: num(),
		totalBytes: num(),
	}),
	wireObj({ status: lit("ready"), model: SpeechModel }),
	wireObj({
		status: lit("failed"),
		model: SpeechModel,
		code: SpeechErrorCode,
		/** A previously installed model that still works after a failed switch. */
		usable: nullable(SpeechModel),
	}),
]);
export type SpeechInstallState = Static<typeof SpeechInstallState>;

/** `path` is a user-installed `nemo-speech`; ThinkRail never deletes it. */
export const SpeechRuntimeInfo = wireObj({
	source: oneOf(["managed", "path"]),
	version: str(),
	backend: str(),
});
export type SpeechRuntimeInfo = Static<typeof SpeechRuntimeInfo>;

export const SpeechEngineState = oneOf(["stopped", "starting", "ready", "failed"]);
export type SpeechEngineState = Static<typeof SpeechEngineState>;

const SpeechDownloadBytes: Schema<Record<SpeechModel, number>> = wireObj({
	multilingual: num(),
	english: num(),
});

/** Voice input as the host reports it in `ServerWelcome.speech` and on `speech.changed`. */
export const SpeechStatus = wireObj({
	supported: bool(),
	install: SpeechInstallState,
	runtime: nullable(SpeechRuntimeInfo),
	engine: SpeechEngineState,
	/** Bytes ThinkRail's own speech files occupy on the host. */
	diskBytes: num(),
	/** What installing each model would download now, given what is already present. */
	downloadBytes: SpeechDownloadBytes,
});
export type SpeechStatus = Static<typeof SpeechStatus>;

export const SPEECH_METHODS = {
	"speech.install": { params: wireObj({ model: SpeechModel }), result: Ack },
	"speech.cancelInstall": { params: NoParams, result: Ack },
	"speech.remove": { params: NoParams, result: Ack },
};

export const SPEECH_CHANNELS = {
	"speech.changed": SpeechStatus,
};
