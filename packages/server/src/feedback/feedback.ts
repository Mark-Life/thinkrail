import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SurveyInvitationResponse } from "@thinkrail/contracts";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { dataDir } from "../persistence";
import {
	currentInAppSurvey,
	refreshInAppSurvey,
	surveyNow,
	surveyRefreshDue,
	surveyWaitPeriodMs,
} from "./survey";

interface FeedbackState {
	acceptedMessages: number;
	nextInvitationAt: number;
	dismissed: boolean;
	submittedSurveyId: string | null;
	submittedIteration: number | null;
	lastInvitedAt: number | null;
}

type FeedbackPublisher = (clientKey: string) => boolean;

const INVITATION_INTERVAL = 10;
const DEFAULT_STATE: FeedbackState = {
	acceptedMessages: 0,
	nextInvitationAt: INVITATION_INTERVAL,
	dismissed: false,
	submittedSurveyId: null,
	submittedIteration: null,
	lastInvitedAt: null,
};

let cachedState: FeedbackState | null = null;
let claimedClient: string | null = null;
let publishInvitation: FeedbackPublisher | null = null;

const Count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

const StoredStateSchema = Type.Object({
	acceptedMessages: Count,
	nextInvitationAt: Count,
	dismissed: Type.Boolean(),
	submittedSurveyId: Type.Optional(
		Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
	),
	submittedIteration: Type.Optional(Type.Union([Count, Type.Null()])),
	lastInvitedAt: Type.Optional(Type.Union([Count, Type.Null()])),
});

function parseState(value: unknown): FeedbackState | null {
	if (!Check(StoredStateSchema, value)) return null;
	return {
		acceptedMessages: value.acceptedMessages,
		nextInvitationAt: value.nextInvitationAt,
		dismissed: value.dismissed,
		submittedSurveyId: value.submittedSurveyId ?? null,
		submittedIteration: value.submittedIteration ?? null,
		lastInvitedAt: value.lastInvitedAt ?? null,
	};
}

function loadState(): FeedbackState {
	if (cachedState) return cachedState;
	try {
		const stored: unknown = JSON.parse(readFileSync(join(dataDir(), "feedback.json"), "utf8"));
		cachedState = parseState(stored) ?? { ...DEFAULT_STATE };
	} catch {
		cachedState = { ...DEFAULT_STATE };
	}
	return cachedState;
}

function writeState(next: FeedbackState): void {
	const directory = dataDir();
	const file = join(directory, "feedback.json");
	const temporary = `${file}.${process.pid}.tmp`;
	mkdirSync(directory, { recursive: true });
	try {
		writeFileSync(temporary, `${JSON.stringify(next, null, "\t")}\n`, "utf8");
		renameSync(temporary, file);
	} catch (error) {
		try {
			rmSync(temporary, { force: true, recursive: true });
		} catch {}
		throw error;
	}
}

function saveState(next: FeedbackState): void {
	writeState(next);
	cachedState = next;
}

function addWithinSafeRange(value: number, amount: number): number {
	return Math.min(value + amount, Number.MAX_SAFE_INTEGER);
}

export function setFeedbackPublisher(publisher: FeedbackPublisher | null): void {
	publishInvitation = publisher;
	if (publisher === null) claimedClient = null;
}

export function surveyIsCompleted(id: string, iteration: number): boolean {
	const current = loadState();
	return current.submittedSurveyId === id && current.submittedIteration === iteration;
}

export function completeSurvey(id: string, iteration: number): void {
	if (!id || !Check(Count, iteration)) throw new Error("Invalid survey completion");
	const next = { ...loadState(), submittedSurveyId: id, submittedIteration: iteration };
	cachedState = next;
	claimedClient = null;
	writeState(next);
}

export function recordAcceptedMessage(clientKey: string): void {
	const current = loadState();
	const next = {
		...current,
		acceptedMessages: addWithinSafeRange(current.acceptedMessages, 1),
	};
	cachedState = next;
	try {
		writeState(next);
	} catch {
		return;
	}
	if (surveyRefreshDue()) void refreshInAppSurvey().then(() => maybeOffer(clientKey));
	else maybeOffer(clientKey);
}

function maybeOffer(clientKey: string): void {
	const current = loadState();
	if (
		current.dismissed ||
		!surveyOfferAvailable() ||
		current.acceptedMessages < current.nextInvitationAt ||
		claimedClient !== null
	) {
		return;
	}
	claimedClient = clientKey;
	if (deliverInvitation(clientKey)) recordInvitation();
}

function surveyOfferAvailable(): boolean {
	const survey = currentInAppSurvey();
	if (!survey || surveyIsCompleted(survey.id, survey.iteration)) return false;
	const lastInvitedAt = loadState().lastInvitedAt;
	const wait = surveyWaitPeriodMs(survey);
	return lastInvitedAt === null || wait === 0 || surveyNow() - lastInvitedAt >= wait;
}

function recordInvitation(): void {
	const next = { ...loadState(), lastInvitedAt: surveyNow() };
	cachedState = next;
	try {
		writeState(next);
	} catch {}
}

function deliverInvitation(clientKey: string): boolean {
	try {
		if (publishInvitation?.(clientKey) === true) return true;
	} catch {}
	claimedClient = null;
	return false;
}

export function redeliverInvitation(clientKey: string): void {
	if (claimedClient === clientKey) deliverInvitation(clientKey);
}

export function respondToInvitation(action: SurveyInvitationResponse): void {
	const current = loadState();
	let next: FeedbackState;
	switch (action) {
		case "postpone":
			next = {
				...current,
				nextInvitationAt: addWithinSafeRange(current.acceptedMessages, INVITATION_INTERVAL),
			};
			break;
		case "never":
			next = { ...current, dismissed: true };
			break;
		default:
			throw new Error("Invalid invitation response");
	}
	saveState(next);
	claimedClient = null;
}

export function releaseInvitation(clientKey: string): void {
	if (claimedClient === clientKey) claimedClient = null;
}

export function resetFeedbackForTests(): void {
	cachedState = null;
	claimedClient = null;
	publishInvitation = null;
}
