import type { Translator } from "@thinkrail/locales/react";
import type { ActivityAuthor } from "../store";

export function writerLabel(t: Translator, author: ActivityAuthor, title: string): string {
	if (author.kind === "user") return author.mine ? t("presence.you") : t("presence.youElsewhere");
	if (author.kind === "external") return t("presence.external");
	const name = title ? t("presence.agentNamed", { name: title }) : t("presence.agent");
	return author.via === "script" ? t("presence.viaScript", { name }) : name;
}

export function writerInitial(t: Translator, author: ActivityAuthor, title: string): string {
	const source =
		author.kind === "agent"
			? title || t("presence.agent")
			: t(author.kind === "external" ? "presence.external" : "presence.you");
	return Array.from(source.trim())[0]?.toUpperCase() ?? "";
}
