import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GithubStarAsk } from "@thinkrail/contracts";
import { fakeFetch } from "../../test/fakeFetch";
import { observeLoggedErrors } from "../log";
import {
	completeSurvey,
	recordAcceptedMessage,
	redeliverInvitation,
	releaseInvitation,
	resetFeedbackForTests,
	respondToInvitation,
	setFeedbackPublisher,
	setGithubStarPublisher,
	surveyIsCompleted,
} from "./feedback";
import { fetchGithubStars, setGithubStarsFetchForTests } from "./githubStars";
import {
	configureSurveySource,
	refreshInAppSurvey,
	resetSurveyForTests,
	setSurveyClockForTests,
} from "./survey";

interface StoredFeedback {
	acceptedMessages: number;
	nextInvitationAt: number;
	dismissed: boolean;
	submittedSurveyId: string | null;
	submittedIteration: number | null;
	lastInvitedAt: number | null;
	githubStarAsked: boolean;
}

function feedback(overrides: Partial<StoredFeedback> = {}): StoredFeedback {
	return {
		acceptedMessages: 0,
		nextInvitationAt: 20,
		dismissed: false,
		submittedSurveyId: null,
		submittedIteration: null,
		lastInvitedAt: null,
		githubStarAsked: false,
		...overrides,
	};
}

async function launch(...surveys: Array<{ id: string; iteration: number }>): Promise<void> {
	const list = surveys.map((survey) => ({
		id: survey.id,
		name: "in-app-feedback",
		start_date: "2026-10-28T00:00:00.000Z",
		current_iteration: survey.iteration,
		questions: [{ id: "q1", type: "open", question: "How is it going?" }],
	}));
	configureSurveySource({
		apiKey: "phc_test",
		fetchImpl: fakeFetch(async () => new Response(JSON.stringify(list))),
	});
	await refreshInAppSurvey();
}

let directory: string;
const savedDataDir = process.env.THINKRAIL_DATA_DIR;

function stored(): unknown {
	return JSON.parse(readFileSync(join(directory, "feedback.json"), "utf8"));
}

beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "thinkrail-feedback-test-"));
	process.env.THINKRAIL_DATA_DIR = directory;
	resetFeedbackForTests();
	await launch({ id: "survey-1", iteration: 1 });
});

afterEach(() => {
	resetFeedbackForTests();
	setGithubStarsFetchForTests(null);
	resetSurveyForTests();
	rmSync(directory, { recursive: true, force: true });
	if (savedDataDir === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = savedDataDir;
});

test("missing and malformed state use the complete defaults", () => {
	respondToInvitation("postpone");
	expect(stored()).toEqual(feedback({ nextInvitationAt: 10 }));

	for (const malformed of [
		"{not json",
		JSON.stringify({ acceptedMessages: -1, nextInvitationAt: 10, dismissed: false }),
		JSON.stringify({ acceptedMessages: 0.5, nextInvitationAt: 10, dismissed: false }),
		JSON.stringify({
			acceptedMessages: 0,
			nextInvitationAt: Number.MAX_SAFE_INTEGER + 1,
			dismissed: false,
		}),
		JSON.stringify({ acceptedMessages: 0, nextInvitationAt: 10, dismissed: "false" }),
	]) {
		writeFileSync(join(directory, "feedback.json"), malformed);
		resetFeedbackForTests();
		recordAcceptedMessage("client-a");
		expect(stored()).toEqual(feedback({ acceptedMessages: 1 }));
	}
});

test("a failed atomic replacement preserves durable state and cleans its temporary path", () => {
	respondToInvitation("never");
	const durable = stored();
	const temporary = join(directory, `feedback.json.${process.pid}.tmp`);
	mkdirSync(temporary);

	expect(() => respondToInvitation("postpone")).toThrow();
	expect(stored()).toEqual(durable);
	expect(existsSync(temporary)).toBe(false);
});

test("accepted messages persist synchronously and one client holds the eligible claim", () => {
	const delivered: string[] = [];
	setFeedbackPublisher((clientKey) => {
		delivered.push(clientKey);
		return true;
	});

	for (let count = 0; count < 19; count += 1) recordAcceptedMessage("client-a");
	expect(delivered).toEqual([]);
	expect(stored()).toMatchObject({ acceptedMessages: 19 });

	recordAcceptedMessage("client-a");
	expect(delivered).toEqual(["client-a"]);
	recordAcceptedMessage("client-b");
	releaseInvitation("client-b");
	recordAcceptedMessage("client-b");
	expect(delivered).toEqual(["client-a"]);
	expect(stored()).toMatchObject({ acceptedMessages: 22 });

	releaseInvitation("client-a");
	recordAcceptedMessage("client-b");
	expect(delivered).toEqual(["client-a", "client-b"]);
	expect(stored()).toMatchObject({ acceptedMessages: 23 });
});

test("postpone schedules ten additional accepted messages and clears the claim", () => {
	const delivered: string[] = [];
	setFeedbackPublisher((clientKey) => {
		delivered.push(clientKey);
		return true;
	});
	for (let count = 0; count < 20; count += 1) recordAcceptedMessage("client-a");

	respondToInvitation("postpone");
	expect(stored()).toEqual(
		feedback({ acceptedMessages: 20, nextInvitationAt: 30, lastInvitedAt: expect.any(Number) }),
	);
	for (let count = 0; count < 9; count += 1) recordAcceptedMessage("client-b");
	expect(delivered).toEqual(["client-a"]);
	recordAcceptedMessage("client-b");
	expect(delivered).toEqual(["client-a", "client-b"]);
});

test("never records dismissal without stopping later counting", () => {
	recordAcceptedMessage("client-a");
	respondToInvitation("never");
	expect(stored()).toEqual(feedback({ acceptedMessages: 1, dismissed: true }));

	resetFeedbackForTests();
	recordAcceptedMessage("client-b");
	expect(stored()).toEqual(feedback({ acceptedMessages: 2, dismissed: true }));
});

test("a legacy dismissal from the interview invitation keeps the survey invitation silent", () => {
	const delivered: string[] = [];
	writeFileSync(
		join(directory, "feedback.json"),
		JSON.stringify({ acceptedMessages: 30, nextInvitationAt: 10, dismissed: true }),
	);
	resetFeedbackForTests();
	setFeedbackPublisher((clientKey) => {
		delivered.push(clientKey);
		return true;
	});
	recordAcceptedMessage("client-a");
	expect(delivered).toEqual([]);
});

test("don't ask again keeps counting but does not offer the usage prompt again", () => {
	const delivered: string[] = [];
	setFeedbackPublisher((clientKey) => {
		delivered.push(clientKey);
		return true;
	});
	for (let count = 0; count < 20; count += 1) recordAcceptedMessage("client-a");
	expect(delivered).toEqual(["client-a"]);
	respondToInvitation("never");
	for (let count = 0; count < 10; count += 1) recordAcceptedMessage("client-b");
	expect(delivered).toEqual(["client-a"]);
	expect(stored()).toEqual(
		feedback({ acceptedMessages: 30, dismissed: true, lastInvitedAt: expect.any(Number) }),
	);
});

test("failed delivery and process-local reset release eligible claims", () => {
	const attempts: string[] = [];
	setFeedbackPublisher((clientKey) => {
		attempts.push(clientKey);
		return false;
	});
	for (let count = 0; count < 20; count += 1) recordAcceptedMessage("client-a");

	setFeedbackPublisher((clientKey) => {
		attempts.push(clientKey);
		return true;
	});
	recordAcceptedMessage("client-b");
	expect(attempts).toEqual(["client-a", "client-b"]);

	resetFeedbackForTests();
	setFeedbackPublisher((clientKey) => {
		attempts.push(clientKey);
		return true;
	});
	recordAcceptedMessage("client-c");
	expect(attempts).toEqual(["client-a", "client-b", "client-c"]);
	expect(stored()).toEqual(feedback({ acceptedMessages: 22, lastInvitedAt: expect.any(Number) }));
});

test("a throwing publisher releases the claim without losing the accepted count", () => {
	setFeedbackPublisher(() => {
		throw new Error("socket closed");
	});
	for (let count = 0; count < 20; count += 1) recordAcceptedMessage("client-a");
	expect(stored()).toMatchObject({ acceptedMessages: 20 });

	const delivered: string[] = [];
	setFeedbackPublisher((clientKey) => {
		delivered.push(clientKey);
		return true;
	});
	recordAcceptedMessage("client-b");
	expect(delivered).toEqual(["client-b"]);
});

test("count persistence failure preserves an existing claim and cannot reject a product send", () => {
	const delivered: string[] = [];
	setFeedbackPublisher((clientKey) => {
		delivered.push(clientKey);
		return true;
	});
	for (let count = 0; count < 20; count += 1) recordAcceptedMessage("client-a");

	const blockedDataDir = join(directory, "not-a-directory");
	writeFileSync(blockedDataDir, "blocked");
	process.env.THINKRAIL_DATA_DIR = blockedDataDir;
	expect(() => recordAcceptedMessage("client-b")).not.toThrow();

	process.env.THINKRAIL_DATA_DIR = directory;
	recordAcceptedMessage("client-b");
	expect(delivered).toEqual(["client-a"]);
	expect(stored()).toMatchObject({ acceptedMessages: 22 });
});

test("a failed threshold write is retained and offered after persistence recovers", () => {
	const delivered: string[] = [];
	setFeedbackPublisher((clientKey) => {
		delivered.push(clientKey);
		return true;
	});
	for (let count = 0; count < 19; count += 1) recordAcceptedMessage("client-a");

	const blockedDataDir = join(directory, "not-a-directory");
	writeFileSync(blockedDataDir, "blocked");
	process.env.THINKRAIL_DATA_DIR = blockedDataDir;
	recordAcceptedMessage("client-a");
	expect(delivered).toEqual([]);

	process.env.THINKRAIL_DATA_DIR = directory;
	recordAcceptedMessage("client-b");
	expect(delivered).toEqual(["client-b"]);
	expect(stored()).toMatchObject({ acceptedMessages: 21 });
});

test("reconnect redelivers only to the claimed client and releases a failed redelivery", () => {
	const attempts: string[] = [];
	setFeedbackPublisher((clientKey) => {
		attempts.push(clientKey);
		return true;
	});
	for (let count = 0; count < 20; count += 1) recordAcceptedMessage("client-a");

	redeliverInvitation("client-b");
	redeliverInvitation("client-a");
	expect(attempts).toEqual(["client-a", "client-a"]);

	setFeedbackPublisher((clientKey) => {
		attempts.push(clientKey);
		return false;
	});
	redeliverInvitation("client-a");
	setFeedbackPublisher((clientKey) => {
		attempts.push(clientKey);
		return true;
	});
	recordAcceptedMessage("client-b");
	expect(attempts).toEqual(["client-a", "client-a", "client-a", "client-b"]);
});

test("an old feedback file without survey completion still counts", () => {
	writeFileSync(
		join(directory, "feedback.json"),
		JSON.stringify({ acceptedMessages: 4, nextInvitationAt: 10, dismissed: true }),
	);
	resetFeedbackForTests();
	recordAcceptedMessage("client-a");
	expect(stored()).toEqual(
		feedback({ acceptedMessages: 5, nextInvitationAt: 10, dismissed: true }),
	);
});

test("a launched, unfinished survey is required before the invitation, per id and iteration", async () => {
	const delivered: string[] = [];
	setFeedbackPublisher((clientKey) => {
		delivered.push(clientKey);
		return true;
	});
	await launch();
	for (let count = 0; count < 20; count += 1) recordAcceptedMessage("client-a");
	expect(delivered).toEqual([]);

	await launch({ id: "survey-1", iteration: 1 });
	recordAcceptedMessage("client-a");
	expect(delivered).toEqual(["client-a"]);

	completeSurvey("survey-1", 1);
	expect(surveyIsCompleted("survey-1", 1)).toBe(true);
	expect(surveyIsCompleted("survey-1", 2)).toBe(false);
	releaseInvitation("client-a");
	recordAcceptedMessage("client-b");
	expect(delivered).toEqual(["client-a"]);

	await launch({ id: "survey-1", iteration: 2 });
	recordAcceptedMessage("client-b");
	expect(delivered).toEqual(["client-a", "client-b"]);
	expect(stored()).toEqual(
		feedback({
			acceptedMessages: 23,
			submittedSurveyId: "survey-1",
			submittedIteration: 1,
			lastInvitedAt: expect.any(Number),
		}),
	);
});

test("a malformed survey completion resets the file to the defaults", () => {
	writeFileSync(
		join(directory, "feedback.json"),
		JSON.stringify({
			acceptedMessages: 3,
			nextInvitationAt: 10,
			dismissed: false,
			submittedSurveyId: 4,
			submittedIteration: 1,
		}),
	);
	resetFeedbackForTests();
	recordAcceptedMessage("client-a");
	expect(stored()).toEqual(feedback({ acceptedMessages: 1 }));
});

test("an idle host does not invite from a copy it can no longer refresh", async () => {
	let status = 200;
	let at = 1_000;
	setSurveyClockForTests(() => at);
	configureSurveySource({
		apiKey: "phc_test",
		fetchImpl: fakeFetch(async () =>
			status === 200
				? new Response(
						JSON.stringify([
							{
								id: "survey-1",
								name: "in-app-feedback",
								start_date: "2026-10-28T00:00:00.000Z",
								questions: [{ id: "q1", type: "open", question: "How is it going?" }],
							},
						]),
					)
				: new Response("down", { status }),
		),
	});
	await refreshInAppSurvey();
	const delivered: string[] = [];
	setFeedbackPublisher((clientKey) => {
		delivered.push(clientKey);
		return true;
	});
	for (let count = 0; count < 19; count += 1) recordAcceptedMessage("client-a");

	status = 503;
	at += 2 * 60 * 60 * 1000;
	recordAcceptedMessage("client-a");
	await Bun.sleep(0);
	await refreshInAppSurvey();
	expect(delivered).toEqual([]);

	status = 200;
	at += 15 * 60 * 1000;
	recordAcceptedMessage("client-a");
	await Bun.sleep(0);
	await refreshInAppSurvey();
	await Bun.sleep(0);
	expect(delivered).toEqual(["client-a"]);
});

test("PostHog's wait period keeps a postponed invitation away for that many days", async () => {
	let at = 1_000_000;
	setSurveyClockForTests(() => at);
	configureSurveySource({
		apiKey: "phc_test",
		fetchImpl: fakeFetch(
			async () =>
				new Response(
					JSON.stringify([
						{
							id: "survey-1",
							name: "in-app-feedback",
							start_date: "2026-10-28T00:00:00.000Z",
							conditions: { seenSurveyWaitPeriodInDays: 7 },
							questions: [{ id: "q1", type: "open", question: "How is it going?" }],
						},
					]),
				),
		),
	});
	await refreshInAppSurvey();
	const delivered: string[] = [];
	setFeedbackPublisher((clientKey) => {
		delivered.push(clientKey);
		return true;
	});
	const send = async (count: number) => {
		for (let index = 0; index < count; index += 1) recordAcceptedMessage("client-a");
		await refreshInAppSurvey();
		await Bun.sleep(0);
	};

	await send(20);
	expect(delivered).toEqual(["client-a"]);
	expect(stored()).toMatchObject({ lastInvitedAt: at });
	respondToInvitation("postpone");

	at += 24 * 60 * 60 * 1000;
	await send(10);
	expect(delivered).toEqual(["client-a"]);

	at += 6 * 24 * 60 * 60 * 1000;
	await send(1);
	expect(delivered).toEqual(["client-a", "client-a"]);
});

test("a malformed invitation time resets the file to the defaults", () => {
	writeFileSync(
		join(directory, "feedback.json"),
		JSON.stringify({
			acceptedMessages: 3,
			nextInvitationAt: 10,
			dismissed: false,
			lastInvitedAt: "x",
		}),
	);
	resetFeedbackForTests();
	recordAcceptedMessage("client-a");
	expect(stored()).toEqual(feedback({ acceptedMessages: 1 }));
});

function publisher(
	ask: (clientKey: string, ask: GithubStarAsk) => boolean,
	canAsk: (clientKey: string) => boolean = () => true,
) {
	return { canAsk, ask };
}

function githubReply(reply: unknown, calls: { count: number } = { count: 0 }): typeof fetch {
	return fakeFetch(async () => {
		calls.count += 1;
		return reply === undefined
			? new Response("rate limited", { status: 403 })
			: new Response(JSON.stringify(reply));
	});
}

function githubStars(stars: number | null, calls: { count: number } = { count: 0 }): typeof fetch {
	return githubReply(stars === null ? undefined : { stargazers_count: stars }, calls);
}

test("a star count reply that fails its schema reads as no count", async () => {
	const replies: unknown[] = [
		{ stargazers_count: 12 },
		{ stargazers_count: "12" },
		{ stargazers_count: -1 },
		{ stargazers_count: 1.5 },
		[],
		null,
	];
	const counts: Array<number | null> = [];
	for (const reply of replies) {
		setGithubStarsFetchForTests(githubReply(reply));
		counts.push(await fetchGithubStars());
	}
	expect(counts).toEqual([12, null, null, null, null, null]);
});

test("the GitHub star ask goes once, on the tenth accepted message, with the star count", async () => {
	const asked: Array<[string, GithubStarAsk]> = [];
	const calls = { count: 0 };
	setGithubStarsFetchForTests(githubStars(7124, calls));
	setGithubStarPublisher(
		publisher((clientKey, ask) => {
			asked.push([clientKey, ask]);
			return true;
		}),
	);
	for (let count = 0; count < 9; count += 1) recordAcceptedMessage("client-a");
	expect(calls.count).toBe(0);
	recordAcceptedMessage("client-b");
	recordAcceptedMessage("client-a");
	await Bun.sleep(0);
	expect(asked).toEqual([["client-b", { stars: 7124 }]]);
	expect(calls.count).toBe(1);
	for (let count = 0; count < 20; count += 1) recordAcceptedMessage("client-a");
	await Bun.sleep(0);
	expect(asked).toHaveLength(1);
	expect(stored()).toMatchObject({ githubStarAsked: true });

	resetFeedbackForTests();
	setGithubStarsFetchForTests(githubStars(7124, calls));
	setGithubStarPublisher(
		publisher((clientKey, ask) => {
			asked.push([clientKey, ask]);
			return true;
		}),
	);
	recordAcceptedMessage("client-a");
	await Bun.sleep(0);
	expect(asked).toHaveLength(1);
	expect(calls.count).toBe(1);
});

test("an unreachable GitHub still asks, without a count", async () => {
	const asked: GithubStarAsk[] = [];
	setGithubStarsFetchForTests(
		fakeFetch(async () => {
			throw new Error("offline");
		}),
	);
	setGithubStarPublisher(
		publisher((_clientKey, ask) => {
			asked.push(ask);
			return true;
		}),
	);
	for (let count = 0; count < 10; count += 1) recordAcceptedMessage("client-a");
	await Bun.sleep(0);
	expect(asked).toEqual([{ stars: null }]);

	resetFeedbackForTests();
	writeFileSync(
		join(directory, "feedback.json"),
		JSON.stringify(feedback({ acceptedMessages: 9 })),
	);
	setGithubStarsFetchForTests(githubStars(null));
	setGithubStarPublisher(
		publisher((_clientKey, ask) => {
			asked.push(ask);
			return true;
		}),
	);
	recordAcceptedMessage("client-a");
	await Bun.sleep(0);
	expect(asked).toEqual([{ stars: null }, { stars: null }]);
});

test("an undelivered GitHub star ask retries on the next message", async () => {
	const asked: string[] = [];
	setGithubStarsFetchForTests(githubStars(7124));
	setGithubStarPublisher(publisher(() => false));
	for (let count = 0; count < 10; count += 1) recordAcceptedMessage("client-a");
	await Bun.sleep(0);
	expect(stored()).toMatchObject({ githubStarAsked: false });
	setGithubStarPublisher(
		publisher(() => {
			throw new Error("socket closed");
		}),
	);
	recordAcceptedMessage("client-a");
	await Bun.sleep(0);
	setGithubStarPublisher(
		publisher((clientKey) => {
			asked.push(clientKey);
			return true;
		}),
	);
	recordAcceptedMessage("client-a");
	await Bun.sleep(0);
	expect(asked).toEqual(["client-a"]);
	expect(stored()).toEqual(feedback({ acceptedMessages: 12, githubStarAsked: true }));
});

test("an install already past ten messages is asked once, and a due survey waits one message", async () => {
	writeFileSync(
		join(directory, "feedback.json"),
		JSON.stringify({ acceptedMessages: 30, nextInvitationAt: 10, dismissed: false }),
	);
	resetFeedbackForTests();
	const sent: string[] = [];
	setGithubStarsFetchForTests(githubStars(7124));
	setGithubStarPublisher(
		publisher(() => {
			sent.push("star");
			return true;
		}),
	);
	setFeedbackPublisher(() => {
		sent.push("survey");
		return true;
	});
	recordAcceptedMessage("client-a");
	recordAcceptedMessage("client-a");
	await Bun.sleep(0);
	expect(sent).toEqual(["star"]);
	recordAcceptedMessage("client-a");
	expect(sent).toEqual(["star", "survey"]);
});

test("a malformed GitHub star flag resets the file to the defaults", () => {
	writeFileSync(
		join(directory, "feedback.json"),
		JSON.stringify({
			acceptedMessages: 3,
			nextInvitationAt: 20,
			dismissed: false,
			githubStarAsked: "yes",
		}),
	);
	resetFeedbackForTests();
	recordAcceptedMessage("client-a");
	expect(stored()).toEqual(feedback({ acceptedMessages: 1 }));
});

test("a client that cannot show the star ask neither reads GitHub nor holds back the survey", () => {
	const calls = { count: 0 };
	const sent: string[] = [];
	setGithubStarsFetchForTests(githubStars(7124, calls));
	setGithubStarPublisher(
		publisher(
			() => {
				sent.push("star");
				return true;
			},
			() => false,
		),
	);
	setFeedbackPublisher(() => {
		sent.push("survey");
		return true;
	});
	for (let count = 0; count < 20; count += 1) recordAcceptedMessage("old-client");
	expect(sent).toEqual(["survey"]);
	expect(calls.count).toBe(0);
	expect(stored()).toMatchObject({ githubStarAsked: false });
});

test("a feedback file from before the survey fields loads with their defaults", () => {
	writeFileSync(
		join(directory, "feedback.json"),
		JSON.stringify({ acceptedMessages: 7, nextInvitationAt: 20, dismissed: true }),
	);
	recordAcceptedMessage("client");
	const saved = JSON.parse(readFileSync(join(directory, "feedback.json"), "utf8"));
	expect(saved).toEqual(feedback({ acceptedMessages: 8, nextInvitationAt: 20, dismissed: true }));
});

test("a feedback file of the wrong shape starts over and keeps a copy", () => {
	const raw = JSON.stringify({ acceptedMessages: -1, nextInvitationAt: 20, dismissed: true });
	writeFileSync(join(directory, "feedback.json"), raw);
	recordAcceptedMessage("client");
	const saved = JSON.parse(readFileSync(join(directory, "feedback.json"), "utf8"));
	expect(saved).toEqual(feedback({ acceptedMessages: 1 }));
	const copy = readdirSync(directory).find((name) => name.includes(".corrupt-"));
	expect(readFileSync(join(directory, `${copy}`), "utf8")).toBe(raw);
});

test("a feedback file that could not be read is not replaced", () => {
	mkdirSync(join(directory, "feedback.json"));
	expect(() => completeSurvey("survey-1", 1)).toThrow("could not be read");
	expect(readdirSync(join(directory, "feedback.json"))).toEqual([]);
});

test("a counted message that cannot be saved is logged with a code and kept in memory", () => {
	const logged: unknown[] = [];
	observeLoggedErrors((scope, error) => {
		if (scope === "feedback") logged.push(error);
	});
	try {
		recordAcceptedMessage("client");
		mkdirSync(join(directory, `feedback.json.${process.pid}.tmp`));
		recordAcceptedMessage("client");
		expect(logged).toEqual([expect.objectContaining({ code: "STATE_FILE_WRITE_FAILED" })]);
		expect(stored()).toEqual(feedback({ acceptedMessages: 1 }));
		recordAcceptedMessage("client");
		expect(stored()).toEqual(feedback({ acceptedMessages: 3 }));
	} finally {
		observeLoggedErrors(null);
	}
});

test("a counted message over an unreadable file logs the refusal's own code", () => {
	const logged: unknown[] = [];
	observeLoggedErrors((scope, error) => {
		if (scope === "feedback") logged.push(error);
	});
	try {
		mkdirSync(join(directory, "feedback.json"));
		recordAcceptedMessage("client");
		expect(logged).toEqual([expect.objectContaining({ code: "STATE_FILE_UNREADABLE" })]);
	} finally {
		observeLoggedErrors(null);
	}
	expect(() => completeSurvey("", 1)).toThrow(expect.objectContaining({ code: "SURVEY_INVALID" }));
});
