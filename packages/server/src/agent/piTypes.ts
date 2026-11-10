import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";

/** pi's `AgentMessage` with pi-coding-agent's message roles, reached through an export of pi-coding-agent's root. */
export type AgentMessage = SessionMessageEntry["message"];
