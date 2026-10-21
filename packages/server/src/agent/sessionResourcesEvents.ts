let publish: (payload: { workspaceId: string; sessionId: string }) => void = () => {};
export function setSessionResourcesPublisher(fn: typeof publish): void {
	publish = fn;
}
export function publishSessionResourcesChanged(workspaceId: string, sessionId: string): void {
	publish({ workspaceId, sessionId });
}
