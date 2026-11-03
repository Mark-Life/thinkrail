import { expect, test } from "bun:test";
import type { PiEvent, SessionEventPayload, SessionId, WsEnvelope } from "@thinkrail/contracts";
import { WS_CHANNELS } from "@thinkrail/contracts";
import { testSessionId } from "@thinkrail/contracts/test-ids";
import { createPiEventBatcher, shouldFlushPiEventsBefore } from "./piEventBatcher";

const payload = (sessionId: SessionId, event: PiEvent): SessionEventPayload => ({
	sessionId,
	event,
});

function manualScheduler() {
	let scheduled: (() => void) | null = null;
	return {
		schedule: (flush: () => void) => {
			scheduled = flush;
			return () => {
				if (scheduled === flush) scheduled = null;
			};
		},
		pending: () => scheduled,
	};
}

test("batches consecutive Pi events in exact arrival order", () => {
	const delivered: (readonly SessionEventPayload[])[] = [];
	const scheduler = manualScheduler();
	const batcher = createPiEventBatcher((events) => delivered.push(events), {
		schedule: scheduler.schedule,
	});
	const first = payload(testSessionId("a"), { type: "agent_start" });
	const second = payload(testSessionId("b"), { type: "turn_start" });

	batcher.enqueue(first);
	batcher.enqueue(second);
	expect(delivered).toEqual([]);
	expect(scheduler.pending()).not.toBeNull();
	scheduler.pending()?.();

	expect(delivered).toEqual([[first, second]]);
	expect(scheduler.pending()).toBeNull();
});

test("the queue ceiling forces a flush and disposal drops pending work", () => {
	const delivered: (readonly SessionEventPayload[])[] = [];
	const scheduler = manualScheduler();
	const batcher = createPiEventBatcher((events) => delivered.push(events), {
		maxBatchSize: 2,
		schedule: scheduler.schedule,
	});
	const first = payload(testSessionId("a"), { type: "agent_start" });
	const second = payload(testSessionId("a"), { type: "turn_start" });
	const third = payload(testSessionId("a"), { type: "agent_end", messages: [], willRetry: false });

	batcher.enqueue(first);
	batcher.enqueue(second);
	expect(delivered).toEqual([[first, second]]);
	expect(scheduler.pending()).toBeNull();

	batcher.enqueue(third);
	expect(scheduler.pending()).not.toBeNull();
	batcher.dispose();
	scheduler.pending()?.();
	batcher.enqueue(first);
	batcher.flush();

	expect(delivered).toEqual([[first, second]]);
});

test("responses and non-Pi pushes form dispatch barriers", () => {
	const piPush: WsEnvelope = {
		channel: WS_CHANNELS.piEvent,
		data: payload(testSessionId("a"), { type: "agent_start" }),
	};
	const otherPush: WsEnvelope = {
		channel: WS_CHANNELS.workspaceFsChanged,
		data: {},
	};
	const response: WsEnvelope = { id: "r1", ok: true, result: {} };

	expect(shouldFlushPiEventsBefore(piPush)).toBe(false);
	expect(shouldFlushPiEventsBefore(otherPush)).toBe(true);
	expect(shouldFlushPiEventsBefore(response)).toBe(true);
});
