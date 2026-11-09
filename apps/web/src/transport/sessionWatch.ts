import { SESSION_WATCH_MAX_IDS } from "@thinkrail/contracts";

export const SESSION_WATCH_LEASE_GRACE_MS = 5_000;

export interface SessionWatchDependencies {
	supported: () => boolean;
	runtimeIds: () => readonly string[];
	send: (method: "session.watch" | "session.unwatch", sessionIds: string[]) => Promise<unknown>;
	graceMs?: number;
}

function chunks(ids: readonly string[]): string[][] {
	const out: string[][] = [];
	for (let i = 0; i < ids.length; i += SESSION_WATCH_MAX_IDS)
		out.push(ids.slice(i, i + SESSION_WATCH_MAX_IDS));
	return out;
}

export function createSessionWatch(deps: SessionWatchDependencies) {
	const sent = new Set<string>();
	const leases = new Map<string, number>();
	const graceMs = deps.graceMs ?? SESSION_WATCH_LEASE_GRACE_MS;

	const send = (method: "session.watch" | "session.unwatch", ids: readonly string[]) => {
		for (const batch of chunks(ids)) deps.send(method, batch).catch(() => {});
	};

	const sync = () => {
		if (!deps.supported()) {
			sent.clear();
			return;
		}
		const desired = new Set([...deps.runtimeIds(), ...leases.keys()]);
		const added = [...desired].filter((id) => !sent.has(id));
		const removed = [...sent].filter((id) => !desired.has(id));
		for (const id of added) sent.add(id);
		for (const id of removed) sent.delete(id);
		send("session.watch", added);
		send("session.unwatch", removed);
	};

	const release = (sessionId: string) => {
		const count = leases.get(sessionId) ?? 0;
		if (count <= 1) leases.delete(sessionId);
		else leases.set(sessionId, count - 1);
		sync();
	};

	return {
		sync,
		restate() {
			sent.clear();
			sync();
		},
		lease(sessionId: string) {
			leases.set(sessionId, (leases.get(sessionId) ?? 0) + 1);
			sync();
			let released = false;
			return () => {
				if (released) return;
				released = true;
				setTimeout(() => release(sessionId), graceMs);
			};
		},
	};
}
