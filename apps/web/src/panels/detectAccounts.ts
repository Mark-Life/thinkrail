import type { DetectedAccount } from "@thinkrail/contracts";
import { selectHostWelcomed, useAppStore } from "@/store";
import { getTransport } from "@/transport";

export function detectAccounts(): Promise<DetectedAccount[]> {
	if (!selectHostWelcomed(useAppStore.getState())) return Promise.resolve([]);
	return getTransport()
		.request("provider.detect", {})
		.then((result) => result.accounts)
		.catch(() => []);
}
