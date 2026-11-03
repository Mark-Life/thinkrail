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
} from "@earendil-works/pi-schema";
import { JsonObject } from "@thinkrail/contracts";

export const IN_APP_SURVEY_NAME = "in-app-feedback";

const UUID =
	"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
export const LANGUAGE_KEY = /^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$/;

const Text = opt(nullable(str()));
const Flag = opt(nullable(bool()));
const Choices = opt(nullable(arr(str())));
const Count = int({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

export const PostHogSurveyList = compile(
	union([arr(unknown()), obj({ surveys: arr(unknown()) }, { open: true })]),
);

export const PostHogSurvey = compile(
	obj(
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
	),
);

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
		scale: opt(nullable(num())),
		display: Text,
		lowerBoundLabel: Text,
		upperBoundLabel: Text,
		translations: opt(unknown()),
	},
	{ open: true },
);
export const PostHogQuestion = compile(QuestionShape);
export type PostHogQuestion = Static<typeof QuestionShape>;

const AppearanceShape = obj(
	{
		placeholder: Text,
		displayThankYouMessage: Flag,
		thankYouMessageHeader: Text,
		shuffleQuestions: Flag,
	},
	{ open: true },
);
export const SurveyAppearance = compile(AppearanceShape);
export const NO_APPEARANCE: Static<typeof AppearanceShape> = {};

export const Conditions = compile(
	obj({ seenSurveyWaitPeriodInDays: opt(nullable(num())) }, { open: true }),
);

export const TranslationMap = JsonObject;
export const PostHogSurveyTranslation = compile(
	obj({ thankYouMessageHeader: Text }, { open: true }),
);
export const PostHogQuestionTranslation = compile(
	obj(
		{
			question: Text,
			description: Text,
			choices: Choices,
			lowerBoundLabel: Text,
			upperBoundLabel: Text,
		},
		{ open: true },
	),
);

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
