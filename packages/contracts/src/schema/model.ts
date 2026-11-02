import {
	arr,
	bool,
	lit,
	nullable,
	num,
	oneOf,
	opt,
	type Static,
	str,
	union,
} from "@earendil-works/pi-schema";
import { ProviderAuthKind } from "./provider";
import { NoParams, wireObj } from "./wire";

export const ThinkingLevel = oneOf(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ThinkingLevel = Static<typeof ThinkingLevel>;

export const WireModelAuth = wireObj({
	kind: ProviderAuthKind,
	/** Account, plan, or variable name behind the connection (e.g. `ANTHROPIC_API_KEY`), when pi knows it. */
	detail: opt(str()),
});
export type WireModelAuth = Static<typeof WireModelAuth>;

export const WireModel = wireObj({
	id: str(),
	name: str(),
	provider: str(),
	contextWindow: num(),
	reasoning: bool(),
	thinkingLevels: arr(ThinkingLevel),
	/** Per-million-token list prices; absent from hosts older than the picker-metadata protocol. */
	cost: opt(wireObj({ input: num(), output: num() })),
	/** Accepted input modalities; absent from hosts older than the picker-metadata protocol. */
	input: opt(arr(oneOf(["text", "image"]))),
	/** How the model's provider is connected — decides whether `cost` is what the user pays. */
	auth: opt(WireModelAuth),
});
export type WireModel = Static<typeof WireModel>;

export const RefreshedModels = wireObj({ models: arr(WireModel), complete: bool() });
export type RefreshedModels = Static<typeof RefreshedModels>;

export const ModelDefault = wireObj({ model: nullable(WireModel), thinkingLevel: ThinkingLevel });
export type ModelDefault = Static<typeof ModelDefault>;

export const ModelContextTarget = union([
	lit("available"),
	wireObj({ provider: str(), id: str() }),
]);
export type ModelContextTarget = Static<typeof ModelContextTarget>;

export const ModelContextSetting = wireObj({
	provider: str(),
	id: str(),
	name: str(),
	contextWindow: num(),
	override: nullable(num()),
});
export type ModelContextSetting = Static<typeof ModelContextSetting>;

export const MODEL_METHODS = {
	"model.list": { params: NoParams, result: arr(WireModel) },
	"model.clampThinking": {
		params: wireObj({ provider: str(), id: str(), level: ThinkingLevel }),
		result: wireObj({ level: ThinkingLevel }),
	},
	"model.refresh": { params: wireObj({ force: opt(bool()) }), result: RefreshedModels },
	"model.default": { params: NoParams, result: ModelDefault },
	"model.contextSettings": { params: NoParams, result: arr(ModelContextSetting) },
	"model.setContextWindow": {
		params: wireObj({ target: ModelContextTarget, contextWindow: nullable(num()) }),
		result: arr(ModelContextSetting),
	},
};
