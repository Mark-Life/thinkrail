import {
	arr,
	bool,
	lit,
	num,
	oneOf,
	opt,
	type Static,
	str,
	union,
} from "@earendil-works/pi-schema";
import { Ack, NoParams, wireObj } from "./wire";

export const ProviderAuthKind = oneOf(["oauth", "api-key", "env", "central", "other"]);
export type ProviderAuthKind = Static<typeof ProviderAuthKind>;

export const ProviderStatus = wireObj({
	id: str(),
	name: str(),
	configured: bool(),
	kind: opt(ProviderAuthKind),
	detail: opt(str()),
	canOAuth: opt(bool()),
	canApiKey: opt(bool()),
	canLogout: opt(bool()),
});
export type ProviderStatus = Static<typeof ProviderStatus>;

export const DetectedAccountSource = oneOf([
	"claude-code",
	"codex",
	"github-copilot",
	"copilot-cli",
	"kimi-cli",
	"grok-build",
]);
export type DetectedAccountSource = Static<typeof DetectedAccountSource>;

export const DetectedAccount = wireObj({
	providerId: str(),
	source: DetectedAccountSource,
	plan: opt(str()),
});
export type DetectedAccount = Static<typeof DetectedAccount>;

export const JbcentralInstall = wireObj({
	platform: str(),
	shell: oneOf(["bash", "powershell"]),
	command: str(),
});
export type JbcentralInstall = Static<typeof JbcentralInstall>;

export const JbcentralAction = oneOf(["connect", "disconnect", "start-proxy", "update"]);
export type JbcentralAction = Static<typeof JbcentralAction>;

export const JbcentralProbeFailureReason = oneOf([
	"launch-failed",
	"timed-out",
	"output-too-large",
	"nonzero-exit",
]);
export type JbcentralProbeFailureReason = Static<typeof JbcentralProbeFailureReason>;

export const JbcentralActionFailureReason = oneOf([
	"not-installed",
	"unsupported-version",
	"version-probe-failed",
	"central-action-failed",
	"artifact-missing",
	"artifact-present",
	"candidate-failed",
]);
export type JbcentralActionFailureReason = Static<typeof JbcentralActionFailureReason>;

export const JbcentralStatus = union([
	wireObj({ state: lit("absent") }),
	wireObj({ state: lit("outdated"), version: str() }),
	wireObj({ state: lit("supported"), version: str(), signedOut: bool() }),
	wireObj({
		state: lit("configured"),
		version: str(),
		signedOut: bool(),
		proxyStopped: bool(),
	}),
	wireObj({ state: lit("malformed-version") }),
	wireObj({ state: lit("probe-failed"), reason: JbcentralProbeFailureReason }),
	wireObj({ state: lit("configuring"), action: opt(JbcentralAction) }),
	wireObj({
		state: lit("load-failed"),
		configured: bool(),
		action: opt(JbcentralAction),
		reason: lit("candidate-failed"),
	}),
]);
export type JbcentralStatus = Static<typeof JbcentralStatus>;

/** A pi `warnings.*` setting the host surfaces; `anthropicExtraUsage` warns that Claude subscription auth bills per token. */
export const ProviderWarning = oneOf(["anthropicExtraUsage"]);
export type ProviderWarning = Static<typeof ProviderWarning>;

export const ProviderStatusReport = wireObj({
	providers: arr(ProviderStatus),
	jbcentral: JbcentralStatus,
	jbcentralInstall: JbcentralInstall,
	/** pi's global `warnings.*` switches (default on); absent from hosts older than v99. */
	warnings: opt(wireObj({ anthropicExtraUsage: bool() })),
});
export type ProviderStatusReport = Static<typeof ProviderStatusReport>;

export const JbcentralActionResult = union([
	wireObj({ outcome: lit("applied") }),
	wireObj({ outcome: lit("failed"), reason: JbcentralActionFailureReason }),
]);
export type JbcentralActionResult = Static<typeof JbcentralActionResult>;

export const JbcentralConnectResult = JbcentralActionResult;
export type JbcentralConnectResult = JbcentralActionResult;

export const JbcentralLoginResult = union([
	wireObj({ outcome: lit("launched") }),
	wireObj({
		outcome: lit("failed"),
		reason: oneOf([
			"not-installed",
			"unsupported-version",
			"version-probe-failed",
			"launch-failed",
		]),
	}),
]);
export type JbcentralLoginResult = Static<typeof JbcentralLoginResult>;

export const JbcentralQuotaSnapshot = union([
	wireObj({ state: lit("hidden") }),
	wireObj({ state: lit("available"), remaining: num(), total: num(), observedAt: num() }),
	wireObj({ state: lit("stale"), remaining: num(), total: num(), observedAt: num() }),
	wireObj({ state: lit("unavailable") }),
]);
export type JbcentralQuotaSnapshot = Static<typeof JbcentralQuotaSnapshot>;

export const LoginReply = wireObj({ loginId: str(), value: str() });
export type LoginReply = Static<typeof LoginReply>;

export const PROVIDER_METHODS = {
	"provider.status": { params: NoParams, result: ProviderStatusReport },
	"provider.detect": { params: NoParams, result: wireObj({ accounts: arr(DetectedAccount) }) },
	"provider.loginStart": {
		params: wireObj({ providerId: str(), type: opt(oneOf(["oauth", "api_key"])) }),
		result: wireObj({ loginId: str() }),
	},
	"provider.loginReply": { params: LoginReply, result: Ack },
	"provider.loginCancel": { params: wireObj({ loginId: str() }), result: Ack },
	"provider.logout": { params: wireObj({ providerId: str() }), result: Ack },
	"provider.disableWarning": { params: wireObj({ warning: ProviderWarning }), result: Ack },
	"provider.jbcentralConnect": { params: NoParams, result: JbcentralConnectResult },
	"provider.jbcentralDisconnect": { params: NoParams, result: JbcentralActionResult },
	"provider.jbcentralStartProxy": { params: NoParams, result: JbcentralActionResult },
	"provider.jbcentralLogin": { params: NoParams, result: JbcentralLoginResult },
	"provider.jbcentralUpdate": { params: NoParams, result: JbcentralActionResult },
	"provider.jbcentralQuota": {
		params: wireObj({ force: opt(bool()) }),
		result: JbcentralQuotaSnapshot,
	},
};
