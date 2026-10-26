import type { FsChangeAuthor } from "@thinkrail/contracts";
import type { Translator } from "@thinkrail/locales/react";

export function writerLabel(t: Translator, author: FsChangeAuthor, title: string): string {
	if (author.kind === "user") return t("presence.you");
	if (author.kind === "external") return t("presence.external");
	const name = title ? t("presence.agentNamed", { name: title }) : t("presence.agent");
	return author.via === "script" ? t("presence.viaScript", { name }) : name;
}

export function writerInitial(t: Translator, author: FsChangeAuthor, title: string): string {
	const source =
		author.kind === "agent"
			? title || t("presence.agent")
			: t(author.kind === "external" ? "presence.external" : "presence.you");
	return Array.from(source.trim())[0]?.toUpperCase() ?? "";
}
