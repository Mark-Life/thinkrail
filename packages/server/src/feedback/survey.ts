import {
	type AppSurvey,
	SURVEY_OPEN_TEXT_LIMIT,
	type SurveyAnswerValue,
	type SurveyQuestion,
	surveyRatingValues,
} from "@thinkrail/contracts";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

export const IN_APP_SURVEY_NAME = "in-app-feedback";
export const SURVEY_REFRESH_MS = 15 * 60 * 1000;
export const SURVEY_STALE_MS = 60 * 60 * 1000;

const SURVEY_LIST_LIMIT = 1_000_000;
const FETCH_TIMEOUT_MS = 10_000;
const QUESTION_LIMIT = 1_000;
const DESCRIPTION_LIMIT = 2_000;
const CHOICE_LIMIT = 500;
const CHOICE_COUNT_LIMIT = 30;
const DEFAULT_HOST = "https://eu.i.posthog.com";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LANGUAGE_KEY = /^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$/;

const MaybeText = Type.Optional(Type.Union([Type.String(), Type.Null()]));
const MaybeFlag = Type.Optional(Type.Union([Type.Boolean(), Type.Null()]));
const MaybeNumber = Type.Optional(Type.Union([Type.Number(), Type.Null()]));
const MaybeChoices = Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()]));
const MaybeTranslations = Type.Optional(
	Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
);

const TranslationSchema = Type.Object({
	question: MaybeText,
	description: MaybeText,
	choices: MaybeChoices,
	lowerBoundLabel: MaybeText,
	upperBoundLabel: MaybeText,
	thankYouMessageHeader: MaybeText,
});

const QuestionBase = {
	id: Type.String(),
	question: Type.String(),
	description: MaybeText,
	optional: MaybeFlag,
	translations: MaybeTranslations,
};

const QuestionSchema = Type.Union([
	Type.Object({ ...QuestionBase, type: Type.Literal("open") }),
	Type.Object({
		...QuestionBase,
		type: Type.Union([Type.Literal("single_choice"), Type.Literal("multiple_choice")]),
		choices: Type.Array(Type.String()),
		hasOpenChoice: MaybeFlag,
		shuffleOptions: MaybeFlag,
	}),
	Type.Object({
		...QuestionBase,
		type: Type.Literal("rating"),
		scale: Type.Union([Type.Literal(3), Type.Literal(5), Type.Literal(7), Type.Literal(10)]),
		display: MaybeText,
		lowerBoundLabel: MaybeText,
		upperBoundLabel: MaybeText,
	}),
]);

const AppearanceSchema = Type.Object({
	placeholder: MaybeText,
	displayThankYouMessage: MaybeFlag,
	thankYouMessageHeader: MaybeText,
	shuffleQuestions: MaybeFlag,
});

const ConditionsSchema = Type.Object({ seenSurveyWaitPeriodInDays: MaybeNumber });

const EntrySchema = Type.Object({
	name: Type.String(),
	id: Type.String(),
	archived: MaybeFlag,
	start_date: MaybeText,
	end_date: MaybeText,
	current_iteration: MaybeNumber,
	questions: Type.Optional(Type.Union([Type.Array(Type.Unknown()), Type.Null()])),
	appearance: Type.Optional(Type.Unknown()),
	conditions: Type.Optional(Type.Unknown()),
	translations: MaybeTranslations,
});

const SurveyListSchema = Type.Object({ surveys: Type.Array(Type.Unknown()) });

const SubmissionSchema = Type.Object({
	submissionId: Type.String(),
	surveyId: Type.String({ minLength: 1, maxLength: 128 }),
	iteration: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	language: Type.Optional(Type.String()),
	answers: Type.Optional(
		Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String())])),
	),
	others: Type.Optional(Type.Record(Type.String(), Type.String())),
});

type Question = Static<typeof QuestionSchema>;
type Translation = Static<typeof TranslationSchema>;

export interface SurveySource {
	apiKey: string;
	host?: string;
	fetchImpl?: typeof fetch;
}

export interface ParsedSurveySubmission {
	submissionId: string;
	surveyId: string;
	iteration: number;
	language?: string;
	answers: Record<string, SurveyAnswerValue>;
	others: Record<string, string> | null;
}

interface QuestionTranslation {
	question?: string;
	description?: string;
	choices?: string[];
	lowerBoundLabel?: string;
	upperBoundLabel?: string;
}

interface SurveyTranslations {
	keys: string[];
	thankYou: Map<string, string>;
	questions: Map<string, Map<string, QuestionTranslation>>;
}

const translationsOf = new WeakMap<AppSurvey, SurveyTranslations>();
const waitPeriodOf = new WeakMap<AppSurvey, number>();
const DAY_MS = 24 * 60 * 60 * 1000;
const WAIT_PERIOD_DAY_LIMIT = 3650;

interface ActiveSource {
	apiKey: string;
	host: string;
	fetchImpl: typeof fetch;
}

let source: ActiveSource | null = null;
let cached: AppSurvey | null = null;
let attemptedAt = 0;
let succeededAt = 0;
let generation = 0;
let inFlight: Promise<AppSurvey | null> | null = null;
let clock: () => number = () => Date.now();

export function configureSurveySource(next: SurveySource | null): void {
	generation += 1;
	inFlight = null;
	cached = null;
	attemptedAt = 0;
	succeededAt = 0;
	if (!next?.apiKey) {
		source = null;
		return;
	}
	source = {
		apiKey: next.apiKey,
		host: (next.host ?? DEFAULT_HOST).replace(/\/+$/, ""),
		fetchImpl: next.fetchImpl ?? fetch,
	};
}

export function currentInAppSurvey(): AppSurvey | null {
	if (cached && clock() - succeededAt >= SURVEY_STALE_MS) cached = null;
	return cached;
}

export function surveyNow(): number {
	return clock();
}

export function surveyWaitPeriodMs(survey: AppSurvey): number {
	return waitPeriodOf.get(survey) ?? 0;
}

export function surveyRefreshDue(at = clock()): boolean {
	if (!source) return false;
	return attemptedAt === 0 || at - attemptedAt >= SURVEY_REFRESH_MS;
}

export function setSurveyClockForTests(next: (() => number) | null): void {
	clock = next ?? (() => Date.now());
}

export function resetSurveyForTests(): void {
	generation += 1;
	source = null;
	cached = null;
	attemptedAt = 0;
	succeededAt = 0;
	inFlight = null;
	clock = () => Date.now();
}

export function refreshInAppSurvey(): Promise<AppSurvey | null> {
	const active = source;
	if (!active || !surveyRefreshDue()) return Promise.resolve(currentInAppSurvey());
	return load(active).catch(() => currentInAppSurvey());
}

export function confirmInAppSurvey(): Promise<AppSurvey | null> {
	const active = source;
	if (!active) return Promise.resolve(null);
	return load(active);
}

function load(active: ActiveSource): Promise<AppSurvey | null> {
	if (inFlight) return inFlight;
	const stamp = generation;
	const pending = fetchSurvey(active)
		.then(
			(next) => {
				if (stamp !== generation) throw new Error("survey source changed");
				cached = next;
				attemptedAt = clock();
				succeededAt = attemptedAt;
				return next;
			},
			(error: unknown) => {
				if (stamp === generation) attemptedAt = clock();
				throw error;
			},
		)
		.finally(() => {
			if (inFlight === pending) inFlight = null;
		});
	inFlight = pending;
	return pending;
}

export function selectInAppSurvey(payload: unknown): AppSurvey | null {
	let best: { survey: AppSurvey; started: number } | null = null;
	for (const entry of surveyList(payload)) {
		const selected = selectOne(entry);
		if (!selected) continue;
		if (!best || selected.started >= best.started) best = selected;
	}
	return best?.survey ?? null;
}

export function parseSurveySubmission(value: unknown): ParsedSurveySubmission {
	if (!Check(SubmissionSchema, value)) throw new Error("Invalid survey submission");
	const { submissionId, surveyId, iteration, language } = value;
	const answers = value.answers ?? {};
	const others = value.others ?? null;
	if (
		!UUID.test(submissionId) ||
		(language !== undefined && !LANGUAGE_KEY.test(language)) ||
		!validIds(answers) ||
		!validIds(others ?? {})
	) {
		throw new Error("Invalid survey submission");
	}
	return {
		submissionId,
		surveyId,
		iteration,
		...(language === undefined ? {} : { language }),
		answers,
		others,
	};
}

export function localizeSurvey(survey: AppSurvey, language: string | undefined): AppSurvey {
	const translations = translationsOf.get(survey);
	const key = translations && language ? matchLanguage(translations.keys, language) : null;
	if (!translations || !key) return survey;
	const thankYou = survey.thankYou === undefined ? undefined : pick(translations.thankYou, key);
	return {
		...survey,
		language: key,
		...(thankYou ? { thankYou } : {}),
		questions: survey.questions.map((question) => {
			const translation = translations.questions.get(question.id);
			return translateQuestion(question, translation ? pick(translation, key) : undefined);
		}),
	};
}

export function surveyResponse(
	survey: AppSurvey,
	submission: ParsedSurveySubmission,
): Record<string, unknown> {
	const shown = localizeSurvey(survey, submission.language);
	if (submission.language !== undefined && shown.language !== submission.language) {
		throw new Error("Invalid survey answer");
	}
	return {
		$survey_id: survey.id,
		$survey_iteration: survey.iteration,
		$survey_submission_id: submission.submissionId,
		$survey_completed: true,
		...(shown.language ? { $survey_language: shown.language } : {}),
		$survey_questions: survey.questions.map((question) => ({
			id: question.id,
			question: question.question,
		})),
		...resolveResponses(shown, survey, submission),
	};
}

async function fetchSurvey(active: ActiveSource): Promise<AppSurvey | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await active.fetchImpl(
			`${active.host}/api/surveys/?token=${encodeURIComponent(active.apiKey)}`,
			{
				signal: controller.signal,
				redirect: "error",
				headers: { accept: "application/json" },
			},
		);
		if (!response.ok) throw new Error("survey list failed");
		const body = await response.text();
		if (body.length > SURVEY_LIST_LIMIT) throw new Error("survey list too large");
		const payload: unknown = JSON.parse(body);
		return selectInAppSurvey(payload);
	} finally {
		clearTimeout(timer);
	}
}

function surveyList(payload: unknown): unknown[] {
	if (Array.isArray(payload)) return payload;
	return Check(SurveyListSchema, payload) ? payload.surveys : [];
}

function selectOne(entry: unknown): { survey: AppSurvey; started: number } | null {
	if (!Check(EntrySchema, entry) || entry.name !== IN_APP_SURVEY_NAME) return null;
	if (entry.archived === true || typeof entry.end_date === "string") return null;
	const started = typeof entry.start_date === "string" ? Date.parse(entry.start_date) : Number.NaN;
	if (!Number.isFinite(started)) return null;
	const id = boundedText(entry.id, 128);
	if (!id) return null;
	const questions: SurveyQuestion[] = [];
	const questionTranslations = new Map<string, Map<string, QuestionTranslation>>();
	for (const raw of entry.questions ?? []) {
		if (!Check(QuestionSchema, raw)) continue;
		const mapped = mapQuestion(raw);
		if (!mapped) continue;
		questions.push(mapped);
		const translated = questionTranslationsOf(raw, mapped);
		if (translated.size > 0) questionTranslations.set(mapped.id, translated);
	}
	if (questions.length === 0) return null;
	const appearance = Check(AppearanceSchema, entry.appearance) ? entry.appearance : null;
	const placeholder = boundedText(appearance?.placeholder, 200);
	const showThanks = appearance?.displayThankYouMessage !== false;
	const thankYou = plainText(appearance?.thankYouMessageHeader, 500) ?? "";
	const survey: AppSurvey = {
		id,
		iteration: iterationOf(entry.current_iteration),
		questions,
		...(placeholder ? { placeholder } : {}),
		...(showThanks ? { thankYou } : {}),
		...(appearance?.shuffleQuestions === true ? { shuffleQuestions: true } : {}),
	};
	const conditions = Check(ConditionsSchema, entry.conditions) ? entry.conditions : null;
	const waitDays = conditions?.seenSurveyWaitPeriodInDays;
	if (typeof waitDays === "number" && Number.isFinite(waitDays) && waitDays > 0) {
		waitPeriodOf.set(survey, Math.min(waitDays, WAIT_PERIOD_DAY_LIMIT) * DAY_MS);
	}
	const thankYouTranslations = new Map<string, string>();
	for (const [key, translation] of translationEntries(entry.translations)) {
		const header = plainText(translation.thankYouMessageHeader, 500);
		if (header) thankYouTranslations.set(key, header);
	}
	const keys = new Set(thankYouTranslations.keys());
	for (const translated of questionTranslations.values()) {
		for (const key of translated.keys()) keys.add(key);
	}
	if (keys.size > 0) {
		translationsOf.set(survey, {
			keys: [...keys].sort(),
			thankYou: thankYouTranslations,
			questions: questionTranslations,
		});
	}
	return { survey, started };
}

function mapQuestion(entry: Question): SurveyQuestion | null {
	const id = boundedText(entry.id, 80);
	const question = plainText(entry.question, QUESTION_LIMIT);
	if (!id || !question) return null;
	const description = plainText(entry.description, DESCRIPTION_LIMIT);
	const base = {
		id,
		question,
		...(description ? { description } : {}),
		...(entry.optional === true ? { optional: true as const } : {}),
	};
	if (entry.type === "open") return { ...base, type: "open" };
	if (entry.type === "single_choice" || entry.type === "multiple_choice") {
		const listed = choiceList(entry.choices);
		if (!listed) return null;
		const open = entry.hasOpenChoice === true;
		const choices = open ? listed.slice(0, -1) : listed;
		return {
			...base,
			type: entry.type,
			choices,
			...(open ? { hasOpenChoice: true } : {}),
			...(entry.shuffleOptions === true ? { shuffleOptions: true } : {}),
		};
	}
	if (entry.type === "rating") {
		const scale = entry.scale;
		const emoji = entry.display === "emoji" && (scale === 3 || scale === 5);
		return {
			...base,
			type: "rating",
			display: emoji ? "emoji" : "number",
			scale,
			lowerBoundLabel: plainText(entry.lowerBoundLabel, 80) ?? "",
			upperBoundLabel: plainText(entry.upperBoundLabel, 80) ?? "",
		};
	}
	return null;
}

function resolveResponses(
	survey: AppSurvey,
	base: AppSurvey,
	submission: ParsedSurveySubmission,
): Record<string, SurveyAnswerValue> {
	const responses: Record<string, SurveyAnswerValue> = {};
	const questions = new Map(survey.questions.map((question) => [question.id, question]));
	const baseQuestions = new Map(base.questions.map((question) => [question.id, question]));
	const others = submission.others;
	const ids = new Set([...Object.keys(submission.answers), ...Object.keys(others ?? {})]);
	for (const id of ids) {
		const question = questions.get(id);
		const baseQuestion = baseQuestions.get(id);
		if (!question || !baseQuestion) throw new Error("Invalid survey answer");
		const [value, other] = others
			? [submission.answers[id], others[id]]
			: splitLegacyOther(question, submission.answers[id]);
		responses[`$survey_response_${id}`] = answerFor(question, baseQuestion, value, other);
	}
	for (const question of survey.questions) {
		if (question.optional) continue;
		if (!Object.hasOwn(responses, `$survey_response_${question.id}`)) {
			throw new Error("Invalid survey answer");
		}
	}
	return responses;
}

function answerFor(
	question: SurveyQuestion,
	base: SurveyQuestion,
	value: SurveyAnswerValue | undefined,
	other: string | undefined,
): SurveyAnswerValue {
	if (question.type === "open" || question.type === "rating") {
		if (typeof value !== "string" || other !== undefined) throw new Error("Invalid survey answer");
		if (question.type === "open") {
			const text = value.trim();
			if (!text || text.length > SURVEY_OPEN_TEXT_LIMIT) throw new Error("Invalid survey answer");
			return text;
		}
		if (!surveyRatingValues(question.scale).some((point) => String(point) === value)) {
			throw new Error("Invalid survey answer");
		}
		return value;
	}
	if (base.type !== question.type) throw new Error("Invalid survey answer");
	if (other !== undefined && !question.hasOpenChoice) throw new Error("Invalid survey answer");
	const otherText = other === undefined ? undefined : choiceText(other);
	const toBase = (item: string) => {
		const original = base.choices[question.choices.indexOf(choiceText(item))];
		if (original === undefined) throw new Error("Invalid survey answer");
		return original;
	};
	if (question.type === "single_choice") {
		if ((value === undefined) === (otherText === undefined))
			throw new Error("Invalid survey answer");
		if (otherText !== undefined) return otherText;
		if (typeof value !== "string") throw new Error("Invalid survey answer");
		return toBase(value);
	}
	if (value !== undefined && !Array.isArray(value)) throw new Error("Invalid survey answer");
	const chosen = [...new Set((value ?? []).map(toBase))];
	if (otherText !== undefined) chosen.push(otherText);
	if (chosen.length === 0) throw new Error("Invalid survey answer");
	return chosen;
}

function choiceText(value: string): string {
	const text = value.trim();
	if (!text || text.length > SURVEY_OPEN_TEXT_LIMIT) throw new Error("Invalid survey answer");
	return text;
}

function splitLegacyOther(
	question: SurveyQuestion,
	value: SurveyAnswerValue | undefined,
): [SurveyAnswerValue | undefined, string | undefined] {
	if (value === undefined || !("choices" in question) || !question.hasOpenChoice) {
		return [value, undefined];
	}
	const isChoice = (item: string) => question.choices.includes(item.trim());
	if (typeof value === "string") return isChoice(value) ? [value, undefined] : [undefined, value];
	const typed = value.filter((item) => !isChoice(item));
	if (typed.length > 1) throw new Error("Invalid survey answer");
	const picked = value.filter(isChoice);
	return [picked.length > 0 ? picked : undefined, typed[0]];
}

function matchLanguage(keys: readonly string[], language: string): string | null {
	const target = language.trim().toLowerCase();
	if (keys.includes(target)) return target;
	const baseLanguage = target.split("-")[0] ?? "";
	return target.includes("-") && keys.includes(baseLanguage) ? baseLanguage : null;
}

function pick<T>(translations: Map<string, T>, key: string): T | undefined {
	return translations.get(key) ?? translations.get(key.split("-")[0] ?? "");
}

function translationEntries(
	value: Record<string, unknown> | null | undefined,
): [string, Translation][] {
	return Object.entries(value ?? {}).flatMap(([rawKey, translation]) => {
		const key = rawKey.trim().toLowerCase();
		return LANGUAGE_KEY.test(key) && Check(TranslationSchema, translation)
			? [[key, translation]]
			: [];
	});
}

function questionTranslationsOf(
	raw: Question,
	question: SurveyQuestion,
): Map<string, QuestionTranslation> {
	const result = new Map<string, QuestionTranslation>();
	for (const [key, translation] of translationEntries(raw.translations)) {
		const text = plainText(translation.question, QUESTION_LIMIT);
		const description = plainText(translation.description, DESCRIPTION_LIMIT);
		const listed = "choices" in question ? choiceList(translation.choices) : null;
		const choices =
			listed && "choices" in question && question.hasOpenChoice ? listed.slice(0, -1) : listed;
		const lowerBoundLabel = plainText(translation.lowerBoundLabel, 80);
		const upperBoundLabel = plainText(translation.upperBoundLabel, 80);
		const parsed: QuestionTranslation = {
			...(text ? { question: text } : {}),
			...(description ? { description } : {}),
			...("choices" in question && choices?.length === question.choices.length ? { choices } : {}),
			...(question.type === "rating" && lowerBoundLabel ? { lowerBoundLabel } : {}),
			...(question.type === "rating" && upperBoundLabel ? { upperBoundLabel } : {}),
		};
		if (Object.keys(parsed).length > 0) result.set(key, parsed);
	}
	return result;
}

function translateQuestion(
	question: SurveyQuestion,
	translation: QuestionTranslation | undefined,
): SurveyQuestion {
	if (!translation) return question;
	const shared = {
		question: translation.question ?? question.question,
		...(translation.description || question.description
			? { description: translation.description ?? question.description }
			: {}),
	};
	if (question.type === "rating") {
		return {
			...question,
			...shared,
			lowerBoundLabel: translation.lowerBoundLabel ?? question.lowerBoundLabel,
			upperBoundLabel: translation.upperBoundLabel ?? question.upperBoundLabel,
		};
	}
	if (question.type === "open") return { ...question, ...shared };
	return { ...question, ...shared, choices: translation.choices ?? question.choices };
}

function validIds(record: Record<string, unknown>): boolean {
	return Object.keys(record).every((id) => id.length > 0 && id.length <= 80);
}

function choiceList(value: readonly string[] | null | undefined): string[] | null {
	if (!value || value.length === 0 || value.length > CHOICE_COUNT_LIMIT) return null;
	const choices: string[] = [];
	for (const entry of value) {
		const choice = plainText(entry, CHOICE_LIMIT);
		if (!choice || choices.includes(choice)) return null;
		choices.push(choice);
	}
	return choices;
}

function iterationOf(value: number | null | undefined): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function plainText(value: string | null | undefined, max: number): string | null {
	const raw = boundedText(value, max * 4);
	if (!raw) return null;
	const stripped = raw
		.replace(/<[^>]*>/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return boundedText(stripped, max);
}

function boundedText(value: string | null | undefined, max: number): string | null {
	if (typeof value !== "string") return null;
	const text = value.trim();
	if (!text) return null;
	return text.length > max ? text.slice(0, max) : text;
}
