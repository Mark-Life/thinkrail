import type { Same } from "@thinkrail/contracts";
import type {
	AskUserQuestionItem,
	AskUserQuestionItemView,
	AskUserQuestionOption,
	AskUserQuestionOptionView,
} from "@thinkrail/pi-ask-user-question/core";

type Lenient<T, Kept extends keyof T> = { [K in keyof Pick<T, Kept>]: T[K] } & {
	[K in Exclude<keyof T, Kept>]?: T[K];
};

/** The checked views of a question and an option name exactly the TypeBox schema's fields, each optional but the text and labels. */
export type QuestionViewTie = [
	Same<
		Omit<AskUserQuestionItemView, "options">,
		Lenient<Omit<AskUserQuestionItem, "options">, "question">
	>,
	Same<AskUserQuestionItemView["options"], AskUserQuestionOptionView[]>,
	Same<AskUserQuestionOptionView, Lenient<AskUserQuestionOption, "label">>,
];
