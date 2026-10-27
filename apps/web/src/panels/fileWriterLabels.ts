import type { Translator } from "@thinkrail/locales/react";
import type { ActivityAuthor } from "../store";

const SESSION_SUFFIX_LENGTH = 4;

export function writerLabels(t: Translator, author: ActivityAuthor, title: string) {
	if (author.kind === "user") {
		const label = author.mine ? t("presence.you") : t("presence.youElsewhere");
		return { label, spoken: label };
	}
	if (author.kind === "external") {
		const label = t("presence.external");
		return { label, spoken: label };
	}
	if (title) return { label: title, spoken: t("presence.agentSpoken", { name: title }) };
	const label = t("presence.agentUntitled", {
		id: author.sessionId.slice(-SESSION_SUFFIX_LENGTH),
	});
	return { label, spoken: label };
}
