import { parseSessionId } from "@thinkrail/contracts";

export function requireSessionId(raw: string) {
	const sessionId = parseSessionId(raw);
	if (sessionId === null) throw new Error(`Invalid session id: ${raw}`);
	return sessionId;
}
