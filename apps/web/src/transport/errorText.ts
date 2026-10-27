import type { WsErrorCode } from "@thinkrail/contracts";
import { t } from "@thinkrail/locales/react";
import { wsErrorCode } from "./requestError";

const replayRefusal = (code: WsErrorCode | undefined) => {
	switch (code) {
		case "REQUEST_REPLAY_CONFLICT":
			return t("app.transport.replayConflict");
		case "REQUEST_REPLAY_OVERFLOW":
			return t("app.transport.replayOverflow");
		case "REQUEST_REPLAY_UNRETAINED":
			return t("app.transport.replayUnretained");
		default:
			return null;
	}
};

export function errorText(
	err: unknown,
	fallback = t("app.transport.requestFailedFallback"),
): string {
	const refusal = replayRefusal(wsErrorCode(err));
	if (refusal) return refusal;
	if (err instanceof Error && err.message) return err.message;
	if (typeof err === "string" && err) return err;
	return fallback;
}
