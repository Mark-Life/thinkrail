import { type Static, type TSchema, Type } from "typebox";

/** The limits the schema states to the model; `core.ts` owns their values. */
export interface QuestionnaireLimits {
	minOptions: number;
	maxOptions: number;
	maxHeaderLength: number;
	maxLabelLength: number;
	maxRecommendedReasonLength: number;
}

/** The tool's argument schemas, without and with the file-preview fields. */
export function questionnaireSchemas(limits: QuestionnaireLimits) {
	function filePreviewFields(target: "question" | "option") {
		const subject =
			target === "question"
				? "what this question is about (for example the current state, or the design being approved)"
				: "this option (for example a mockup of this alternative)";
		return {
			previewFile: Type.Optional(
				Type.String({
					description: `Optional workspace-relative path of an existing file rendered as the preview of ${subject}: an HTML mockup, SVG, image, markdown or code. Write the file first. Use either preview or previewFile, not both.`,
				}),
			),
			previewBefore: Type.Optional(
				Type.String({
					description:
						"Optional workspace-relative path of the 'before' file; with previewFile the preview is a before → after diff.",
				}),
			),
		};
	}

	function optionProperties() {
		return {
			label: Type.String({
				description: `MAX ${limits.maxLabelLength} CHARACTERS. The concise (1-5 word) text the user sees and selects.`,
			}),
			description: Type.String({
				description:
					"What this option means or what happens if chosen — the trade-off/implication.",
			}),
			preview: Type.Optional(
				Type.String({
					description:
						"Optional markdown preview of this option (a mockup, code snippet, Mermaid diagram or config) shown beside the options. Single-select only. An option may honestly have none.",
				}),
			),
			recommendedReason: Type.Optional(
				Type.String({
					description: `MAX ${limits.maxRecommendedReasonLength} CHARACTERS. Why you recommend this option — one short sentence, rendered as a 'Why:' line under the option. Set only on the option whose label carries '(Recommended)'.`,
				}),
			),
		};
	}

	function questionProperties() {
		return {
			question: Type.String({
				description:
					'The complete question, ending with a question mark. E.g. "Which library should we use for date formatting?"',
			}),
			header: Type.String({
				description: `MAX ${limits.maxHeaderLength} CHARACTERS. Very short chip/tag next to the question, e.g. "Auth method".`,
			}),
			preview: Type.Optional(
				Type.String({
					description:
						"Optional markdown shown above the options: what this question is about (the design being approved, the text to confirm, the current state). Not a per-option preview.",
				}),
			),
			multiSelect: Type.Optional(
				Type.Boolean({
					default: false,
					description:
						'Allow multiple selections. The "Other" free-text option stays available; its text arrives as an additional answer alongside the checked options.',
				}),
			),
		};
	}

	const OPTIONS_DESCRIPTION =
		"2-4 distinct choices; a single option only to confirm an inference (the statement is the question, the option is 'Looks right'). An 'Other' free-text option, a way to discuss the question first, and a Skip escape are added automatically — do NOT author 'Other'-, 'discuss'- or 'ask me differently'-style options.";

	function optionsArray<T extends TSchema>(option: T) {
		return Type.Array(option, {
			minItems: limits.minOptions,
			maxItems: limits.maxOptions,
			description: OPTIONS_DESCRIPTION,
		});
	}

	const QUESTIONS_DESCRIPTION = "One or more questions to ask.";

	function markdownOnlySchema() {
		const question = Type.Object({
			...questionProperties(),
			options: optionsArray(Type.Object(optionProperties())),
		});
		return Type.Object({
			questions: Type.Array(question, { minItems: 1, description: QUESTIONS_DESCRIPTION }),
		});
	}

	function filePreviewSchema() {
		const question = Type.Object({
			...questionProperties(),
			...filePreviewFields("question"),
			options: optionsArray(Type.Object({ ...optionProperties(), ...filePreviewFields("option") })),
		});
		return Type.Object({
			questions: Type.Array(question, { minItems: 1, description: QUESTIONS_DESCRIPTION }),
		});
	}

	return { markdownOnly: markdownOnlySchema(), filePreview: filePreviewSchema() };
}

/** The argument shape, file-preview fields included: the one definition of a questionnaire. */
export type AskUserQuestionParams = Static<ReturnType<typeof questionnaireSchemas>["filePreview"]>;
