import { oneOf, type Static } from "@earendil-works/pi-schema";
import { Ack, NoParams, wireObj } from "./wire";

export const SPEECH_MODELS = ["multilingual", "english"] as const;
export const SpeechModel = oneOf(SPEECH_MODELS);
export type SpeechModel = Static<typeof SpeechModel>;

export const SPEECH_METHODS = {
	"speech.install": { params: wireObj({ model: SpeechModel }), result: Ack },
	"speech.cancelInstall": { params: NoParams, result: Ack },
	"speech.remove": { params: NoParams, result: Ack },
};
