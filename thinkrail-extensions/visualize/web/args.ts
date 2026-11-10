import type { ComparisonOption } from "@thinkrail/pi-visualize/schema";

/** A comparison option as the card renders it: the lists and the flag are always present. */
export type ComparisonOptionView = ComparisonOption &
	Required<Pick<ComparisonOption, "pros" | "cons" | "recommended">>;

type RawOption = Record<keyof ComparisonOption, unknown>;

function rawOption(entry: unknown): Partial<RawOption> {
	if (typeof entry !== "object" || entry === null) return {};
	return {
		name: "name" in entry ? entry.name : undefined,
		description: "description" in entry ? entry.description : undefined,
		pros: "pros" in entry ? entry.pros : undefined,
		cons: "cons" in entry ? entry.cons : undefined,
		recommended: "recommended" in entry ? entry.recommended : undefined,
		mermaid: "mermaid" in entry ? entry.mermaid : undefined,
	} satisfies RawOption;
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const texts = (value: unknown) =>
	Array.isArray(value) ? value.filter((item: unknown) => typeof item === "string") : [];

/** Reads streaming, possibly partial `options` args leniently: wrong-typed fields fall back to defaults. */
export function parseComparisonOptions(value: unknown): ComparisonOptionView[] {
	if (!Array.isArray(value)) return [];
	return value.map((entry: unknown) => {
		const raw = rawOption(entry);
		const description = text(raw.description);
		const mermaid = text(raw.mermaid);
		return {
			name: text(raw.name) ?? "",
			...(description === undefined ? {} : { description }),
			pros: texts(raw.pros),
			cons: texts(raw.cons),
			recommended: raw.recommended === true,
			...(mermaid === undefined ? {} : { mermaid }),
		};
	});
}
