import type { AssistantMessage, StopReason, TextContent } from "@earendil-works/pi-ai";
import {
	arr,
	bool,
	compile,
	lit,
	nullable,
	num,
	obj,
	oneOf,
	opt,
	type Static,
	str,
} from "@earendil-works/pi-schema";
import type { AskUserQuestionParams } from "./questionSchema.ts";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

export const MIN_OPTIONS = 1;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 16;
export const MAX_LABEL_LENGTH = 60;
export const MAX_RECOMMENDED_REASON_LENGTH = 160;

export const OTHER_LABEL = "Other";
export const CHAT_LABEL = "Chat about this";
export const DISCUSS_LABEL = "Discuss this…";
export const RESERVED_LABELS = [
	OTHER_LABEL,
	"Type something.",
	CHAT_LABEL,
	DISCUSS_LABEL,
	"Next →",
] as const;

export type AskUserQuestionArgs = AskUserQuestionParams;
export type AskUserQuestionItem = AskUserQuestionArgs["questions"][number];
export type AskUserQuestionOption = AskUserQuestionItem["options"][number];
export type AskUserQuestionPreviewFields = Pick<
	AskUserQuestionItem,
	"preview" | "previewFile" | "previewBefore"
>;

export const DISCUSS_REASONS = ["unclear", "irrelevant", "context"] as const;
export type AskUserQuestionDiscussReason = (typeof DISCUSS_REASONS)[number];

export const ANSWER_KINDS = ["option", "custom", "multi", "discuss"] as const;
export type AskUserQuestionAnswerKind = (typeof ANSWER_KINDS)[number];

export const AskUserQuestionAnswer = obj(
	{
		questionIndex: num(),
		question: str(),
		kind: oneOf(ANSWER_KINDS),
		answer: nullable(str()),
		selected: opt(arr(str())),
		notes: opt(str()),
		preview: opt(str()),
		previewFile: opt(str()),
		previewBefore: opt(str()),
		reason: opt(oneOf(DISCUSS_REASONS)),
	},
	{ open: true },
);
export type AskUserQuestionAnswer = Static<typeof AskUserQuestionAnswer>;

export const AskUserQuestionResult = obj(
	{ answers: arr(AskUserQuestionAnswer), cancelled: bool() },
	{ open: true },
);
export type AskUserQuestionResult = Static<typeof AskUserQuestionResult>;

export const AskUserQuestionAckDetails = obj({ kind: lit("ack") }, { open: true });
export type AskUserQuestionAckDetails = Static<typeof AskUserQuestionAckDetails>;

export const isAskUserQuestionResult = compile(AskUserQuestionResult).check;
export const isAckDetails = compile(AskUserQuestionAckDetails).check;

export type AskUserQuestionDetails = AskUserQuestionResult | AskUserQuestionAckDetails;

export type AskOutcome =
	| { kind: "answered"; result: AskUserQuestionResult }
	| { kind: "deferred"; reason?: "chat" }
	| { kind: "abandoned" };

/** The stop reasons after which an assistant message's tool calls may be cut off, so they never run. */
export const NON_EXECUTABLE_STOP_REASONS = [
	"error",
	"aborted",
	"length",
] as const satisfies readonly StopReason[];

export interface AskToolResult<D> {
	content: TextContent[];
	details: D;
	terminate?: boolean;
}

export const ASK_ACK_TEXT =
	"The questions are now shown to the user. This turn ends here; the user's answers (or their own free-form reply) will arrive as the next user message. Do not assume an answer until it arrives.";
export const ASK_CHAT_TEXT =
	"The user chose to discuss these questions in chat instead of answering them here. This turn ends here; their reply will arrive as the next user message. Do not assume an answer until it arrives.";
export const ASK_STOPPED_ERROR = "Question cancelled because the run was stopped";
export const ASK_UNAVAILABLE_TEXT = "Error: UI not available (running in non-interactive mode)";
export const DECLINE_MESSAGE = "User declined to answer questions";

const ENVELOPE_PREFIX = "User has answered your questions:";
const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind.";
const DISCUSS_REASON_TEXT: Record<AskUserQuestionDiscussReason, string> = {
	unclear: "the question is unclear to them",
	irrelevant: "the question seems not relevant to them",
	context: "they need more context",
};
export const DISCUSS_INSTRUCTION =
	"Do not guess answers to the questions the user wants to discuss first: explain each in plain words (what is being decided and why it matters), then ask it again in a later round.";

export interface ValidationResult {
	ok: boolean;
	message: string;
}

export interface ValidationOptions {
	filePreviews?: boolean;
}

export interface PreviewFileSource {
	location: string;
	path: string;
}

function previewTargets(
	args: AskUserQuestionArgs,
): { location: string; target: AskUserQuestionPreviewFields }[] {
	return (args.questions ?? []).flatMap((question, qi) => [
		{ location: `questions[${qi}]`, target: question },
		...(question.options ?? []).map((option, oi) => ({
			location: `questions[${qi}].options[${oi}]`,
			target: option,
		})),
	]);
}

function previewProblem(
	location: string,
	target: AskUserQuestionPreviewFields,
	filePreviews: boolean,
): string | null {
	const file = target.previewFile !== undefined || target.previewBefore !== undefined;
	if (file && !filePreviews)
		return `Error: file previews are not available here (${location}); use a markdown preview instead`;
	if (target.previewBefore !== undefined && target.previewFile === undefined)
		return `Error: ${location}.previewBefore needs previewFile (the after file)`;
	if (target.preview !== undefined && target.previewFile !== undefined)
		return `Error: set either preview or previewFile on ${location}, not both`;
	return null;
}

export function previewFileSources(args: AskUserQuestionArgs): PreviewFileSource[] {
	const seen = new Set<string>();
	const sources: PreviewFileSource[] = [];
	for (const { location, target } of previewTargets(args)) {
		for (const [field, path] of [
			["previewFile", target.previewFile],
			["previewBefore", target.previewBefore],
		] as const) {
			if (typeof path !== "string" || seen.has(path)) continue;
			seen.add(path);
			sources.push({ location: `${location}.${field}`, path });
		}
	}
	return sources;
}

export function validateQuestionnaire(
	args: AskUserQuestionArgs,
	options: ValidationOptions = {},
): ValidationResult {
	const questions = args.questions ?? [];
	if (questions.length === 0)
		return { ok: false, message: "Error: At least one question is required" };

	const seenQuestions = new Set<string>();
	const reserved = new Set<string>(RESERVED_LABELS);
	for (const q of questions) {
		if (seenQuestions.has(q.question))
			return { ok: false, message: "Error: Question text must be unique within a call" };
		seenQuestions.add(q.question);

		if (!q.options || q.options.length < MIN_OPTIONS)
			return {
				ok: false,
				message: `Error: Each question requires at least ${MIN_OPTIONS} option`,
			};

		const seenLabels = new Set<string>();
		for (const o of q.options) {
			if (reserved.has(o.label))
				return {
					ok: false,
					message: `Error: Option label is reserved (${RESERVED_LABELS.join(", ")})`,
				};
			if (seenLabels.has(o.label))
				return { ok: false, message: "Error: Option labels must be unique within a question" };
			seenLabels.add(o.label);
		}
	}
	for (const { location, target } of previewTargets(args)) {
		const problem = previewProblem(location, target, options.filePreviews === true);
		if (problem) return { ok: false, message: problem };
	}
	return { ok: true, message: "" };
}

export function textResult<D>(text: string, details: D): AskToolResult<D> {
	return { content: [{ type: "text", text }], details };
}

function answerSegment(a: AskUserQuestionAnswer): string {
	if (a.kind === "discuss") {
		const why = a.reason ? DISCUSS_REASON_TEXT[a.reason] : undefined;
		const parts = [
			`"${a.question}"=(the user wants to discuss this question first${why ? `: ${why}` : ""})`,
		];
		if (a.notes) parts.push(`user notes: ${a.notes}`);
		return `${parts.join(". ")}.`;
	}
	const scalar = a.kind === "multi" ? (a.selected ?? []).join(", ") : (a.answer ?? "(no answer)");
	const parts = [`"${a.question}"="${scalar}"`];
	if (a.kind === "multi" && a.answer) parts.push(`user's own answer: "${a.answer}"`);
	if (a.previewFile)
		parts.push(
			`selected preview: file ${a.previewBefore ? `${a.previewBefore} → ${a.previewFile}` : a.previewFile}`,
		);
	else if (a.preview) parts.push(`selected preview: ${a.preview}`);
	if (a.notes) parts.push(`user notes: ${a.notes}`);
	return `${parts.join(". ")}.`;
}

export function buildQuestionnaireResponse(
	result: AskUserQuestionResult,
	args: AskUserQuestionArgs,
): AskToolResult<AskUserQuestionResult> {
	if (result.cancelled)
		return textResult(DECLINE_MESSAGE, { answers: result.answers, cancelled: true });
	const segments: string[] = [];
	const declined: string[] = [];
	for (let i = 0; i < args.questions.length; i++) {
		const a = result.answers.find((x) => x.questionIndex === i);
		if (a) segments.push(answerSegment(a));
		else declined.push(`"${args.questions[i]?.question}"`);
	}
	if (segments.length === 0)
		return textResult(DECLINE_MESSAGE, { answers: result.answers, cancelled: true });
	const declinedNote =
		declined.length > 0 ? ` The user declined to answer: ${declined.join(", ")}.` : "";
	const discussNote = result.answers.some((a) => a.kind === "discuss")
		? ` ${DISCUSS_INSTRUCTION}`
		: "";
	return textResult(
		`${ENVELOPE_PREFIX} ${segments.join(" ")}${declinedNote}${discussNote} ${ENVELOPE_SUFFIX}`,
		result,
	);
}

export function outcomeResult(
	outcome: AskOutcome,
	args: AskUserQuestionArgs,
): AskToolResult<AskUserQuestionDetails> {
	switch (outcome.kind) {
		case "answered":
			return buildQuestionnaireResponse(outcome.result, args);
		case "deferred":
			return {
				...textResult<AskUserQuestionDetails>(
					outcome.reason === "chat" ? ASK_CHAT_TEXT : ASK_ACK_TEXT,
					{ kind: "ack" },
				),
				terminate: true,
			};
		case "abandoned":
			return {
				...textResult<AskUserQuestionDetails>(ASK_STOPPED_ERROR, { answers: [], cancelled: true }),
				terminate: true,
			};
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

/** A lenient guard for a question, also while its args stream: the text and labelled options it renders. */
export function isAskUserQuestionItem(value: unknown): value is AskUserQuestionItem {
	return (
		isRecord(value) &&
		typeof value.question === "string" &&
		Array.isArray(value.options) &&
		value.options.every((option) => isRecord(option) && typeof option.label === "string")
	);
}

export function isAskUserQuestionArgs(value: unknown): value is AskUserQuestionArgs {
	const questions = isRecord(value) ? value.questions : undefined;
	return Array.isArray(questions) && questions.length > 0 && questions.every(isAskUserQuestionItem);
}

const NON_EXECUTABLE: ReadonlySet<StopReason> = new Set(NON_EXECUTABLE_STOP_REASONS);

const isAskCall = (block: AssistantMessage["content"][number]) =>
	block.type === "toolCall" && block.name === ASK_USER_QUESTION_TOOL_NAME;

export function executableAskCallIds(message: AssistantMessage): string[] {
	if (NON_EXECUTABLE.has(message.stopReason)) return [];
	return message.content.flatMap((block) =>
		block.type === "toolCall" && block.name === ASK_USER_QUESTION_TOOL_NAME ? [block.id] : [],
	);
}

export function isolateAskUserQuestionBatch(
	message: AssistantMessage,
): AssistantMessage | undefined {
	const askIndex = message.content.findIndex(isAskCall);
	if (askIndex < 0) return undefined;
	const kept = message.content.filter(
		(block, index) => block.type !== "toolCall" || index === askIndex,
	);
	return kept.length === message.content.length ? undefined : { ...message, content: kept };
}
