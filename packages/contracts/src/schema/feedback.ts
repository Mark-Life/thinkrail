import {
	arr,
	lit,
	map,
	nullable,
	num,
	oneOf,
	opt,
	type Static,
	str,
	union,
} from "@earendil-works/pi-schema";
import { Ack, NoPayload, wireObj } from "./wire";

export const SurveyInvitationResponse = oneOf(["postpone", "never"]);
export type SurveyInvitationResponse = Static<typeof SurveyInvitationResponse>;

export const SurveyRatingScale = oneOf([3, 5, 7, 10]);
export type SurveyRatingScale = Static<typeof SurveyRatingScale>;

const SURVEY_QUESTION_BASE_FIELDS = {
	id: str(),
	question: str(),
	description: opt(str()),
	optional: opt(lit(true)),
};

export const SurveyOpenQuestion = wireObj({ ...SURVEY_QUESTION_BASE_FIELDS, type: lit("open") });
export type SurveyOpenQuestion = Static<typeof SurveyOpenQuestion>;

export const SurveyChoiceQuestion = wireObj({
	...SURVEY_QUESTION_BASE_FIELDS,
	type: oneOf(["single_choice", "multiple_choice"]),
	choices: arr(str()),
	hasOpenChoice: opt(lit(true)),
	shuffleOptions: opt(lit(true)),
});
export type SurveyChoiceQuestion = Static<typeof SurveyChoiceQuestion>;

export const SurveyRatingQuestion = wireObj({
	...SURVEY_QUESTION_BASE_FIELDS,
	type: lit("rating"),
	display: oneOf(["number", "emoji"]),
	scale: SurveyRatingScale,
	lowerBoundLabel: str(),
	upperBoundLabel: str(),
});
export type SurveyRatingQuestion = Static<typeof SurveyRatingQuestion>;

export const SurveyQuestion = union([
	SurveyOpenQuestion,
	SurveyChoiceQuestion,
	SurveyRatingQuestion,
]);
export type SurveyQuestion = Static<typeof SurveyQuestion>;

export const AppSurvey = wireObj({
	id: str(),
	iteration: num(),
	questions: arr(SurveyQuestion),
	placeholder: opt(str()),
	thankYou: opt(str()),
	shuffleQuestions: opt(lit(true)),
	language: opt(str()),
});
export type AppSurvey = Static<typeof AppSurvey>;

export const SurveyAnswerValue = union([str(), arr(str())]);
export type SurveyAnswerValue = Static<typeof SurveyAnswerValue>;

export const SurveySubmitParams = wireObj({
	submissionId: str(),
	surveyId: str(),
	iteration: num(),
	language: opt(str()),
	answers: map(SurveyAnswerValue),
	others: opt(map(str())),
});
export type SurveySubmitParams = Static<typeof SurveySubmitParams>;

export const FEEDBACK_METHODS = {
	"feedback.respond": { params: wireObj({ action: SurveyInvitationResponse }), result: Ack },
	"feedback.survey": {
		params: wireObj({ language: opt(str()) }),
		result: wireObj({ survey: nullable(AppSurvey) }),
	},
	"feedback.survey.submit": { params: SurveySubmitParams, result: Ack },
};

export const GithubStarAsk = wireObj({ stars: nullable(num()) });
export type GithubStarAsk = Static<typeof GithubStarAsk>;

export const FEEDBACK_CHANNELS = {
	"feedback.interview": NoPayload,
	"feedback.githubStar": GithubStarAsk,
};
