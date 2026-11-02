import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bool, compile, int, nullable, obj, opt, str } from "@earendil-works/pi-schema";
import type { SurveyInvitationResponse } from "@thinkrail/contracts";
import { assertOverwriteAllowed, dataDir, readStateFile } from "../persistence";
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

const Count = int({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const SurveyIteration = compile(Count);
const StoredState = compile(
	obj(
		{
			acceptedMessages: Count,
			nextInvitationAt: Count,
			dismissed: bool(),
			submittedSurveyId: opt(nullable(str({ minLength: 1, maxLength: 128 }))),
			submittedIteration: opt(nullable(Count)),
			lastInvitedAt: opt(nullable(Count)),
		},
		{ open: true },
	),
);

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

function readState(): FeedbackState {
	const file = readStateFile(join(dataDir(), "feedback.json"));
	if (StoredState.check(file.value)) {
		const { acceptedMessages, nextInvitationAt, dismissed } = file.value;
		return {
			acceptedMessages,
			nextInvitationAt,
			dismissed,
			submittedSurveyId: file.value.submittedSurveyId ?? null,
			submittedIteration: file.value.submittedIteration ?? null,
			lastInvitedAt: file.value.lastInvitedAt ?? null,
		};
	}
	if (file.value !== undefined) file.setAside("not a feedback state");
	return { ...DEFAULT_STATE };
}

function loadState(): FeedbackState {
	cachedState ??= readState();
	return cachedState;
}

function writeState(next: FeedbackState): void {
	const directory = dataDir();
	const file = join(directory, "feedback.json");
	assertOverwriteAllowed(file);
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
	if (!id || !SurveyIteration.check(iteration)) throw new Error("Invalid survey completion");
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
