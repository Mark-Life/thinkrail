import type { Page } from "@playwright/test";
import { parseFrame } from "./wire";

function channelOf(message: unknown): string | null {
	const frame = parseFrame(message);
	return frame && "channel" in frame ? frame.channel : null;
}

function signal() {
	let send = () => {};
	const received = new Promise<void>((resolve) => {
		send = resolve;
	});
	return { received, send };
}

export async function installChannelHold(page: Page) {
	let armed:
		| {
				channel: string;
				held: ReturnType<typeof signal>;
				release: ReturnType<typeof signal>;
		  }
		| undefined;
	await page.routeWebSocket(/\/ws(\?|$)/, (browserSocket) => {
		const serverSocket = browserSocket.connectToServer();
		browserSocket.onMessage((message) => serverSocket.send(message));
		serverSocket.onMessage((message) => {
			const pending = armed;
			if (pending && channelOf(message) === pending.channel) {
				armed = undefined;
				pending.held.send();
				void pending.release.received.then(() => browserSocket.send(message));
				return;
			}
			browserSocket.send(message);
		});
	});
	return {
		arm(channel: string) {
			if (armed) throw new Error(`Already holding ${armed.channel}`);
			const held = signal();
			const release = signal();
			armed = { channel, held, release };
			return { held: held.received, release: release.send };
		},
	};
}
