import { parseSessionId } from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";

export function requireSessionId(raw: string) {
	const sessionId = parseSessionId(raw);
	if (sessionId === null)
		throw new CodedError(
			"PI_SESSION_ID_INVALID",
			"pi named a session with an id that is not path-safe",
		);
	return sessionId;
}
