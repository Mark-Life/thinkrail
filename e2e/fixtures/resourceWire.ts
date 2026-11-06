export function stubResourceWire(subagents: number): void {
	const send = WebSocket.prototype.send;
	WebSocket.prototype.send = function (data) {
		const frame =
			typeof data === "string"
				? (JSON.parse(data) as {
						id?: unknown;
						method?: string;
						params?: { workspaceId?: string; sessionId?: string };
					})
				: null;
		const respond = (result: unknown) =>
			queueMicrotask(() =>
				this.dispatchEvent(
					new MessageEvent("message", {
						data: JSON.stringify({ id: frame?.id, ok: true, result }),
					}),
				),
			);
		if (frame?.method === "session.resources") {
			respond({
				workspaceId: frame.params?.workspaceId,
				sessionId: frame.params?.sessionId,
				commands: [],
				subagents: Array.from({ length: subagents }, (_, index) => ({
					childSessionId: `perf-child-${index}`,
					parentSessionId: frame.params?.sessionId,
					task: `Inspect module ${index}`,
					status: "running",
					createdAt: "2026-01-01T00:00:00.000Z",
				})),
			});
			return;
		}
		if (frame?.method === "subagent.getTranscript") {
			respond({ messages: [], status: "running" });
			return;
		}
		send.call(this, data);
	};
}
