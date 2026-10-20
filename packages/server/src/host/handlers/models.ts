import {
	cancelMcpProbe,
	clampThinkingForModel,
	isMcpLoginId,
	listAvailableModels,
	listModelContextSettings,
	refreshAvailableModels,
	replyMcpProbe,
	setModelContextWindow,
} from "../../agent";
import {
	cancelLogin,
	connectJbcentral,
	disconnectJbcentral,
	getJbcentralQuota,
	getProviderStatus,
	jbcentralLogin,
	logoutProvider,
	resolveLogin,
	startLogin,
	startProxyJbcentral,
	updateJbcentral,
} from "../../auth";
import { getConfig } from "../../settings";
import { dropLogin, recordLoginStart } from "../loginAnalytics";
import { resolveNewChatModel } from "../newChatModel";
import {
	additionalCapture,
	centralConnectOutcome,
	observeSetupAction,
	observeSetupRead,
	providerAvailability,
} from "../productAnalytics";
import type { HandlersFor } from "./types";

export const modelHandlers: HandlersFor<"model" | "provider"> = {
	"model.list": () =>
		observeSetupRead(listAvailableModels, (models) => ({
			model_available: models.length > 0 ? "yes" : "no",
		})),
	"model.clampThinking": async (p) => {
		return { level: await clampThinkingForModel({ provider: p.provider, id: p.id }, p.level) };
	},
	"model.refresh": (p) => {
		return observeSetupRead(
			() => refreshAvailableModels(p.force === true),
			(result) => ({
				model_available: result.models.length > 0 ? "yes" : result.complete ? "no" : "unknown",
			}),
		);
	},
	"model.contextSettings": () => listModelContextSettings(),
	"model.setContextWindow": (p) => {
		return setModelContextWindow(p.target, p.contextWindow);
	},
	"model.default": () =>
		observeSetupRead(
			() => resolveNewChatModel({}),
			(result) => (result.model ? { model_available: "yes" } : {}),
		),
	"provider.status": () =>
		observeSetupRead(getProviderStatus, (report) => ({
			provider_available: providerAvailability(report),
		})),
	"provider.loginStart": (p) => {
		const type = p.type ?? "oauth";
		const capture = additionalCapture();
		const handle = startLogin(p.providerId, type);
		recordLoginStart(handle.loginId, type, capture);
		return handle;
	},
	"provider.loginReply": (reply, ctx) => {
		if (isMcpLoginId(reply.loginId)) replyMcpProbe(reply.loginId, ctx.clientKey, reply.value);
		else resolveLogin(reply);
		return { ok: true } as const;
	},
	"provider.loginCancel": (params, ctx) => {
		const { loginId } = params;
		if (isMcpLoginId(loginId)) {
			cancelMcpProbe(loginId, ctx.clientKey);
			return { ok: true } as const;
		}
		dropLogin(loginId);
		cancelLogin(loginId);
		return { ok: true } as const;
	},
	"provider.logout": async (params) => {
		await logoutProvider(params.providerId);
		return { ok: true } as const;
	},
	"provider.jbcentralConnect": () =>
		observeSetupAction("provider_connect", connectJbcentral, centralConnectOutcome),
	"provider.jbcentralDisconnect": () => disconnectJbcentral(),
	"provider.jbcentralStartProxy": () => startProxyJbcentral(),
	"provider.jbcentralLogin": () => jbcentralLogin(),
	"provider.jbcentralUpdate": () => updateJbcentral(),
	"provider.jbcentralQuota": (params) => {
		const config = getConfig();
		if (!config.jbcentralQuotaEnabled) return { state: "hidden" } as const;
		return getJbcentralQuota({
			maxAgeMs: config.jbcentralQuotaRefreshSeconds * 1_000,
			force: params.force === true,
		});
	},
};
