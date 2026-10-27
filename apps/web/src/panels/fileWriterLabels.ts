import type { Translator } from "@thinkrail/locales/react";
import type { ActivityAuthor } from "../store";

export function writerLabel(t: Translator, author: ActivityAuthor, title: string): string {
	if (author.kind === "user") return author.mine ? t("presence.you") : t("presence.youElsewhere");
	if (author.kind === "external") return t("presence.external");
	const name = title ? t("presence.agentNamed", { name: title }) : t("presence.agent");
	return author.via === "script" ? t("presence.viaScript", { name }) : name;
}
