import {
	arr,
	bool,
	compile,
	int,
	lit,
	nullable,
	num,
	obj,
	oneOf,
	opt,
	type Static,
	str,
	union,
	unknown,
	type Validator,
} from "@earendil-works/pi-schema";
import type * as PostHog from "@posthog/core";
import { JsonObject, type Same } from "@thinkrail/contracts";

export const IN_APP_SURVEY_NAME = "in-app-feedback";

const UUID =
	"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
export const LANGUAGE_KEY = /^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$/;

const Text = opt(nullable(str()));
const Flag = opt(nullable(bool()));
const Choices = opt(nullable(arr(str())));
const Count = int({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

type KeyOf<U> = U extends unknown ? keyof U : never;
type FieldOf<U, P extends PropertyKey> = U extends unknown
	? P extends keyof U
		? NonNullable<U[P]>
		: never
	: never;
/** PostHog's API sends `null` for a field its SDK types as unset, so a read field may be absent or `null`. */
type FromApi<U, K extends KeyOf<U>> = { [P in K]?: FieldOf<U, P> | null };

type ApiQuestion = PostHog.Survey["questions"][number];
type ApiAppearance = NonNullable<PostHog.Survey["appearance"]>;
type ApiConditions = NonNullable<PostHog.Survey["conditions"]>;
type ApiSurveyTranslation = NonNullable<PostHog.Survey["translations"]>[string];
type ApiQuestionTranslation = NonNullable<ApiQuestion["translations"]>[string];

const SurveyList = obj({ surveys: arr(unknown()) }, { open: true });
export const PostHogSurveyList: Validator<
	unknown[] | Same<Static<typeof SurveyList>, Record<keyof PostHog.SurveyResponse, unknown[]>>
> = compile(union([arr(unknown()), SurveyList]));

const SurveyShape = obj(
	{
		name: lit(IN_APP_SURVEY_NAME),
		id: str(),
		start_date: str(),
		archived: Flag,
		end_date: Text,
		current_iteration: opt(nullable(Count)),
		questions: arr(unknown()),
		appearance: opt(unknown()),
		conditions: opt(unknown()),
		translations: opt(unknown()),
	},
	{ open: true },
);
type SurveyReply = Static<typeof SurveyShape>;
type ApiSurvey = Pick<PostHog.Survey, "id"> &
	Required<Pick<PostHog.Survey, "start_date">> &
	FromApi<PostHog.Survey, "end_date" | "current_iteration">;
export const PostHogSurvey: Validator<
	Same<SurveyReply, ApiSurvey & Omit<SurveyReply, keyof ApiSurvey>>
> = compile(SurveyShape);

const QuestionShape = obj(
	{
		id: str(),
		question: str(),
		type: oneOf(["open", "single_choice", "multiple_choice", "rating"]),
		description: Text,
		optional: Flag,
		choices: Choices,
		hasOpenChoice: Flag,
		shuffleOptions: Flag,
		scale: opt(nullable(oneOf([2, 3, 5, 7, 10]))),
		display: opt(nullable(oneOf(["number", "emoji"]))),
		lowerBoundLabel: Text,
		upperBoundLabel: Text,
		translations: opt(unknown()),
	},
	{ open: true },
);
type QuestionReply = Static<typeof QuestionShape>;
type ApiQuestionFields = Pick<ApiQuestion, "id" | "question"> & {
	type: Exclude<ApiQuestion["type"], "link">;
} & FromApi<
		ApiQuestion,
		| "description"
		| "optional"
		| "choices"
		| "hasOpenChoice"
		| "shuffleOptions"
		| "scale"
		| "display"
		| "lowerBoundLabel"
		| "upperBoundLabel"
	>;
export type PostHogQuestion = Same<
	QuestionReply,
	ApiQuestionFields & Omit<QuestionReply, keyof ApiQuestionFields>
>;
export const PostHogQuestion: Validator<PostHogQuestion> = compile(QuestionShape);

const AppearanceShape = obj(
	{
		placeholder: Text,
		displayThankYouMessage: Flag,
		thankYouMessageHeader: Text,
		shuffleQuestions: Flag,
	},
	{ open: true },
);
type Appearance = Same<
	Static<typeof AppearanceShape>,
	FromApi<
		ApiAppearance,
		"placeholder" | "displayThankYouMessage" | "thankYouMessageHeader" | "shuffleQuestions"
	>
>;
export const SurveyAppearance: Validator<Appearance> = compile(AppearanceShape);
export const NO_APPEARANCE: Appearance = {};

const ConditionsShape = obj({ seenSurveyWaitPeriodInDays: opt(nullable(num())) }, { open: true });
export const Conditions: Validator<
	Same<Static<typeof ConditionsShape>, FromApi<ApiConditions, "seenSurveyWaitPeriodInDays">>
> = compile(ConditionsShape);

export const TranslationMap = JsonObject;

const SurveyTranslationShape = obj({ thankYouMessageHeader: Text }, { open: true });
export const PostHogSurveyTranslation: Validator<
	Same<
		Static<typeof SurveyTranslationShape>,
		FromApi<ApiSurveyTranslation, "thankYouMessageHeader">
	>
> = compile(SurveyTranslationShape);

const QuestionTranslationShape = obj(
	{
		question: Text,
		description: Text,
		choices: Choices,
		lowerBoundLabel: Text,
		upperBoundLabel: Text,
	},
	{ open: true },
);
export const PostHogQuestionTranslation: Validator<
	Same<
		Static<typeof QuestionTranslationShape>,
		FromApi<
			ApiQuestionTranslation,
			"question" | "description" | "choices" | "lowerBoundLabel" | "upperBoundLabel"
		>
	>
> = compile(QuestionTranslationShape);

export const SubmissionFields = compile(
	obj(
		{
			submissionId: str({ pattern: UUID }),
			surveyId: str({ minLength: 1, maxLength: 128 }),
			iteration: Count,
			language: opt(str({ pattern: LANGUAGE_KEY.source })),
		},
		{ open: true },
	),
);
