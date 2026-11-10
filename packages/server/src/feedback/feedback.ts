import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bool, compile, int, nullable, obj, opt, str } from "@earendil-works/pi-schema";
import type { GithubStarAsk, SurveyInvitationResponse } from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import { logger } from "../log";
import {
	assertOverwriteAllowed,
	dataDir,
	readStateFile,
	stateFileWriteFailure,
} from "../persistence";
import { fetchGithubStars } from "./githubStars";
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
	githubStarAsked: boolean;
}

type FeedbackPublisher = (clientKey: string) => boolean;
interface GithubStarPublisher {
	canAsk: (clientKey: string) => boolean;
	ask: (clientKey: string, ask: GithubStarAsk) => boolean;
}

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
			githubStarAsked: opt(bool()),
		},
		{ open: true },
	),
);

const INVITATION_INTERVAL = 10;
const FIRST_INVITATION_AT = 20;
const GITHUB_STAR_ASK_AT = 10;
const DEFAULT_STATE: FeedbackState = {
	acceptedMessages: 0,
	nextInvitationAt: FIRST_INVITATION_AT,
	dismissed: false,
	submittedSurveyId: null,
	submittedIteration: null,
	lastInvitedAt: null,
	githubStarAsked: false,
};

const log = logger("feedback");

let cachedState: FeedbackState | null = null;
let claimedClient: string | null = null;
let publishInvitation: FeedbackPublisher | null = null;
let publishGithubStar: GithubStarPublisher | null = null;
let githubStarAskInFlight = false;

function readState(): FeedbackState {
	const file = readStateFile(feedbackFile());
	if (StoredState.check(file.value)) {
		const { acceptedMessages, nextInvitationAt, dismissed } = file.value;
		return {
			acceptedMessages,
			nextInvitationAt,
			dismissed,
			submittedSurveyId: file.value.submittedSurveyId ?? null,
			submittedIteration: file.value.submittedIteration ?? null,
			lastInvitedAt: file.value.lastInvitedAt ?? null,
			githubStarAsked: file.value.githubStarAsked ?? false,
		};
	}
	if (file.value !== undefined) file.setAside("not a feedback state");
	return { ...DEFAULT_STATE };
}

function loadState(): FeedbackState {
	cachedState ??= readState();
	return cachedState;
}

function feedbackFile(): string {
	return join(dataDir(), "feedback.json");
}

function writeState(next: FeedbackState): void {
	const directory = dataDir();
	const file = feedbackFile();
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

/** The in-memory state already changed; a failed write is logged and the next save carries it. */
function writeStateOrLog(next: FeedbackState): boolean {
	try {
		writeState(next);
		return true;
	} catch (error) {
		log.warn("feedback state was not saved", stateFileWriteFailure(feedbackFile(), error));
		return false;
	}
}

function addWithinSafeRange(value: number, amount: number): number {
	return Math.min(value + amount, Number.MAX_SAFE_INTEGER);
}

export function setFeedbackPublisher(publisher: FeedbackPublisher | null): void {
	publishInvitation = publisher;
	if (publisher === null) claimedClient = null;
}

export function setGithubStarPublisher(publisher: GithubStarPublisher | null): void {
	publishGithubStar = publisher;
}

export function surveyIsCompleted(id: string, iteration: number): boolean {
	const current = loadState();
	return current.submittedSurveyId === id && current.submittedIteration === iteration;
}

export function completeSurvey(id: string, iteration: number): void {
	if (!id || !SurveyIteration.check(iteration)) {
		throw new CodedError("SURVEY_INVALID", "Invalid survey completion");
	}
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
	if (!writeStateOrLog(next)) return;
	if (askForGithubStar(clientKey)) return;
	if (surveyRefreshDue()) void refreshInAppSurvey().then(() => maybeOffer(clientKey));
	else maybeOffer(clientKey);
}

function askForGithubStar(clientKey: string): boolean {
	if (githubStarAskInFlight) return true;
	const current = loadState();
	if (current.githubStarAsked || current.acceptedMessages < GITHUB_STAR_ASK_AT) return false;
	try {
		if (publishGithubStar?.canAsk(clientKey) !== true) return false;
	} catch {
		return false;
	}
	githubStarAskInFlight = true;
	void fetchGithubStars().then((stars) => {
		githubStarAskInFlight = false;
		deliverGithubStar(clientKey, { stars });
	});
	return true;
}

function deliverGithubStar(clientKey: string, ask: GithubStarAsk): void {
	try {
		if (publishGithubStar?.ask(clientKey, ask) !== true) return;
	} catch {
		return;
	}
	cachedState = { ...loadState(), githubStarAsked: true };
	writeStateOrLog(cachedState);
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
	writeStateOrLog(next);
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
	publishGithubStar = null;
	githubStarAskInFlight = false;
}
