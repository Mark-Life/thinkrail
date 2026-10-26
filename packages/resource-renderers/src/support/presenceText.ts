import { useT } from "@thinkrail/locales/react";
import type { PresenceText } from "./presenceCore";

export function usePresenceText(): PresenceText {
	const t = useT();
	return {
		hover: (writer) =>
			t(writer.inferred ? "presence.changedByInferred" : "presence.changedBy", {
				name: writer.label,
			}),
		lines: (writer, spans) => {
			const [only] = spans;
			if (only && spans.length === 1) {
				return only.startLine === only.endLine
					? t("presence.changedLine", { name: writer.spoken, line: only.startLine })
					: t("presence.changedLines", {
							name: writer.spoken,
							start: only.startLine,
							end: only.endLine,
						});
			}
			const lines = spans.map((span) =>
				span.startLine === span.endLine
					? String(span.startLine)
					: t("presence.lineRange", { start: span.startLine, end: span.endLine }),
			);
			return t("presence.changedSpans", { name: writer.spoken, lines: lines.join(", ") });
		},
		places: (writer, count) => t("presence.changedPlaces", { name: writer.spoken, count }),
		file: (name) => t("presence.rewrote", { name }),
	};
}
