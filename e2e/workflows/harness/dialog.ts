import "./env";
import { arr, compile, obj, opt, unknown } from "@earendil-works/pi-schema";
import type { SessionId } from "@thinkrail/contracts";
import {
	type AskUserQuestionAnswer,
	type AskUserQuestionItemView,
	type AskUserQuestionResult,
	isAskUserQuestionArgsView,
} from "@thinkrail/pi-ask-user-question/core";
import { completeOnce, respondToTool } from "@thinkrail/server/agent";
import type { EventLog } from "./events";

export interface DialogScriptEntry {
	match: (questions: AskUserQuestionItemView[]) => boolean;
	answer: (questions: AskUserQuestionItemView[]) => AskUserQuestionResult;
}

export interface DialogConfig {
	script?: DialogScriptEntry[];
	persona?: string;
	fallback?: "skip" | "pickRecommended";
}

export type DialogRung = "script" | "persona" | "fallback";

export interface AnsweredRound {
	questions: AskUserQuestionItemView[];
	result: AskUserQuestionResult;
	rung: DialogRung;
	error?: string;
}

export function pickRecommended(questions: AskUserQuestionItemView[]): AskUserQuestionResult {
	const answers: AskUserQuestionAnswer[] = questions.map((q, i) => ({
		questionIndex: i,
		question: q.question,
		kind: "option",
		answer: q.options[0]?.label ?? null,
	}));
	return { answers, cancelled: false };
}

export function skipAll(): AskUserQuestionResult {
	return { answers: [], cancelled: true };
}

const PersonaReply = compile(
	obj(
		{
			answers: arr(obj({ questionIndex: opt(unknown()), answer: opt(unknown()) }, { open: true })),
		},
		{ open: true },
	),
);

const PERSONA_SYSTEM = [
	"You are role-playing a HUMAN USER answering a structured questionnaire inside a dev tool.",
	"Stay in character per the persona brief. For each question pick exactly one existing option",
	"(by its exact label) that best matches the brief.",
	'Reply with ONLY a JSON object: {"answers":[{"questionIndex":<n>,"answer":"<exact option label>"}, …]}',
	"— one entry per question, no markdown, no commentary.",
].join(" ");

export function parsePersonaReply(
	reply: string,
	questions: AskUserQuestionItemView[],
): AskUserQuestionResult | null {
	const jsonMatch = reply.match(/\{[\s\S]*\}/);
	if (!jsonMatch) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonMatch[0]);
	} catch {
		return null;
	}
	if (!PersonaReply.check(parsed)) return null;
	const answers: AskUserQuestionAnswer[] = [];
	for (const entry of parsed.answers) {
		const index = entry.questionIndex;
		if (typeof index !== "number" || index < 0 || index >= questions.length) return null;
		const question = questions[index];
		if (!question) return null;
		const label = String(entry.answer ?? "");
		if (!question.options.some((o) => o.label === label)) return null;
		answers.push({
			questionIndex: index,
			question: question.question,
			kind: "option",
			answer: label,
		});
	}
	return answers.length > 0 ? { answers, cancelled: false } : null;
}

async function personaAnswer(
	questions: AskUserQuestionItemView[],
	brief: string,
): Promise<AskUserQuestionResult | null> {
	try {
		const { text } = await completeOnce({
			system: PERSONA_SYSTEM,
			prompt: `Persona brief: ${brief}\n\nQuestionnaire:\n${JSON.stringify({ questions }, null, 2)}`,
			tier: "cheap",
			maxTokens: 512,
		});
		return parsePersonaReply(text, questions);
	} catch {
		return null;
	}
}

export function attachDialog(
	sessionId: SessionId,
	log: EventLog,
	config: DialogConfig = {},
): { answered: AnsweredRound[]; detach: () => void; settle: () => Promise<void> } {
	const answered: AnsweredRound[] = [];
	const handled = new Set<string>();
	const pending: Promise<void>[] = [];
	const fallback = config.fallback ?? "skip";

	const onGrow = (): void => {
		for (const call of log.toolCalls("ask_user_question")) {
			if (handled.has(call.toolCallId)) continue;
			handled.add(call.toolCallId);
			const questions = isAskUserQuestionArgsView(call.args) ? call.args.questions : [];
			pending.push(answerRound(call.toolCallId, questions));
		}
	};

	const answerRound = async (
		toolCallId: string,
		questions: AskUserQuestionItemView[],
	): Promise<void> => {
		let rung: DialogRung = "fallback";
		let result: AskUserQuestionResult | null = null;
		let error: string | undefined;
		try {
			const scripted = config.script?.find((entry) => entry.match(questions));
			if (scripted) {
				rung = "script";
				result = scripted.answer(questions);
			}
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
			result = null;
		}
		if (!result && !error && config.persona) {
			result = await personaAnswer(questions, config.persona);
			if (result) rung = "persona";
		}
		if (!result) {
			rung = "fallback";
			result = fallback === "pickRecommended" ? pickRecommended(questions) : skipAll();
		}
		const round: AnsweredRound = { questions, result, rung, ...(error ? { error } : {}) };
		answered.push(round);
		try {
			await respondToTool(sessionId, toolCallId, result);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			round.error = round.error ? `${round.error}; delivery: ${message}` : `delivery: ${message}`;
		}
	};

	const detach = log.onGrow(onGrow);
	onGrow();
	const settle = async (): Promise<void> => {
		while (pending.length > 0) {
			const batch = pending.splice(0);
			await Promise.all(batch);
		}
	};
	return { answered, detach, settle };
}
