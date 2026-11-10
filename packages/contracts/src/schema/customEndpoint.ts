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
import { NoParams, wireObj } from "./wire";

/** What the server reported about a model; `null` means it did not say, so pi's default applies. */
export const CustomEndpointModel = wireObj({
	id: str(),
	contextWindow: nullable(num()),
	maxTokens: nullable(num()),
	reasoning: nullable(bool()),
	vision: nullable(bool()),
	/** Whether the server says the model takes tool calls; never saved, so a listed endpoint reports null. */
	tools: nullable(bool()),
});
export type CustomEndpointModel = Static<typeof CustomEndpointModel>;

/** An OpenAI-compatible `custom-*` provider in pi's `models.json`. The key itself never crosses the wire. */
export const CustomEndpoint = wireObj({
	id: str(),
	name: str(),
	baseUrl: str(),
	hasApiKey: bool(),
	models: arr(CustomEndpointModel),
});
export type CustomEndpoint = Static<typeof CustomEndpoint>;

export const CustomEndpointProbeRequest = wireObj({
	baseUrl: str(),
	/** Omitted together with `endpointId` to reuse that endpoint's saved key for its unchanged address. */
	apiKey: opt(str()),
	endpointId: opt(str()),
});
export type CustomEndpointProbeRequest = Static<typeof CustomEndpointProbeRequest>;

export const CustomEndpointProbeFailure = oneOf([
	"invalid-url",
	"unauthorized",
	"timeout",
	"unreachable",
	"not-openai",
	"no-models",
]);
export type CustomEndpointProbeFailure = Static<typeof CustomEndpointProbeFailure>;

export const CustomEndpointProbe = union([
	wireObj({ ok: lit(true), baseUrl: str(), models: arr(CustomEndpointModel) }),
	wireObj({ ok: lit(false), reason: CustomEndpointProbeFailure, status: opt(num()) }),
]);
export type CustomEndpointProbe = Static<typeof CustomEndpointProbe>;

export const CustomEndpointDraft = wireObj({
	/** Present to replace an existing endpoint; absent to add a new one. */
	id: opt(str()),
	name: str(),
	baseUrl: str(),
	/** Omitted to keep the saved key; an empty string removes it. */
	apiKey: opt(str()),
	models: arr(CustomEndpointModel),
});
export type CustomEndpointDraft = Static<typeof CustomEndpointDraft>;

export const CUSTOM_ENDPOINT_METHODS = {
	"customEndpoints.list": { params: NoParams, result: arr(CustomEndpoint) },
	"customEndpoints.probe": { params: CustomEndpointProbeRequest, result: CustomEndpointProbe },
	"customEndpoints.save": { params: CustomEndpointDraft, result: arr(CustomEndpoint) },
	"customEndpoints.remove": { params: wireObj({ id: str() }), result: arr(CustomEndpoint) },
};
