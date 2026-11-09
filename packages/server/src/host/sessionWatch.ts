import { SESSION_WATCH_MAX_IDS, type WsParams } from "@thinkrail/contracts";
import { isPiSessionId } from "../agent";

interface TopicSocket {
	subscribe(topic: string): void;
	unsubscribe(topic: string): void;
}

type SocketLookup = (clientKey: string) => TopicSocket | undefined;

const watches = new Map<string, Set<string>>();
let socketFor: SocketLookup = () => undefined;

export function sessionTopic(sessionId: string): string {
	return `pi.event:${sessionId}`;
}

export function setSessionWatchSockets(lookup: SocketLookup | null) {
	watches.clear();
	socketFor = lookup ?? (() => undefined);
}

export function sessionWatchParams(params: unknown): WsParams<"session.watch"> {
	if (!params || typeof params !== "object" || Array.isArray(params))
		throw new Error("Invalid session watch request");
	const { sessionIds, replace } = params as Record<string, unknown>;
	if (
		!Array.isArray(sessionIds) ||
		sessionIds.length > SESSION_WATCH_MAX_IDS ||
		!sessionIds.every(isPiSessionId)
	)
		throw new Error("Invalid session watch ids");
	if (replace !== undefined && typeof replace !== "boolean")
		throw new Error("Invalid session watch replace flag");
	return replace ? { sessionIds, replace } : { sessionIds };
}

export function watchSessions(clientKey: string, sessionIds: readonly string[], replace = false) {
	if (replace) {
		const keep = new Set(sessionIds);
		unwatchSessions(
			clientKey,
			watchedSessionIds(clientKey).filter((id) => !keep.has(id)),
		);
	}
	let watched = watches.get(clientKey);
	if (!watched) {
		watched = new Set();
		watches.set(clientKey, watched);
	}
	const added = sessionIds.filter((id) => !watched.has(id));
	for (const id of added) watched.add(id);
	if (watched.size === 0) watches.delete(clientKey);
	const ws = socketFor(clientKey);
	for (const id of added) ws?.subscribe(sessionTopic(id));
}

export function unwatchSessions(clientKey: string, sessionIds: readonly string[]) {
	const watched = watches.get(clientKey);
	if (!watched) return;
	const removed = sessionIds.filter((id) => watched.delete(id));
	if (watched.size === 0) watches.delete(clientKey);
	const ws = socketFor(clientKey);
	for (const id of removed) ws?.unsubscribe(sessionTopic(id));
}

export function applySessionWatches(clientKey: string, ws: TopicSocket) {
	for (const id of watches.get(clientKey) ?? []) ws.subscribe(sessionTopic(id));
}

export function dropSessionWatches(clientKey: string) {
	watches.delete(clientKey);
}

export function forgetWatchedSession(sessionId: string) {
	for (const [clientKey, watched] of watches) {
		if (!watched.delete(sessionId)) continue;
		if (watched.size === 0) watches.delete(clientKey);
		socketFor(clientKey)?.unsubscribe(sessionTopic(sessionId));
	}
}

export function watchedSessionIds(clientKey: string): readonly string[] {
	return [...(watches.get(clientKey) ?? [])];
}
