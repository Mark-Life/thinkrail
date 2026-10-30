import type { EventEmitter } from "node:events";
import type Electrobun from "electrobun/main";
import { Type } from "typebox";
import { Check } from "typebox/value";

type NavigationEvent = ReturnType<
	(typeof Electrobun.events.events.webview)["willNavigate" | "newWindowOpen"]
>;

const MAX_NAVIGATION_DETAIL_LENGTH = 64 * 1024;
const NavigationDetailSchema = Type.Object({ url: Type.String() });

export function externalNavigationUrl(value: unknown, origin: string): string | null {
	let detail = value;
	if (typeof detail === "string") {
		if (detail.length > MAX_NAVIGATION_DETAIL_LENGTH) return null;
		if (detail.trimStart().startsWith("{")) {
			try {
				detail = JSON.parse(detail);
			} catch {
				return null;
			}
		}
	}
	const raw =
		typeof detail === "string" ? detail : Check(NavigationDetailSchema, detail) ? detail.url : null;
	if (!raw || raw.length > MAX_NAVIGATION_DETAIL_LENGTH) return null;
	try {
		const url = new URL(raw, origin);
		if (url.origin === origin) return null;
		return ["https:", "http:", "mailto:"].includes(url.protocol) ? url.href : null;
	} catch {
		return null;
	}
}

export function installExternalNavigation(
	events: Pick<EventEmitter, "on" | "off">,
	webviewId: number,
	origin: string,
	openExternal: (url: string) => unknown,
): () => void {
	const names = [`will-navigate-${webviewId}`, `new-window-open-${webviewId}`];
	const onNavigation = (event: NavigationEvent) => {
		const url = externalNavigationUrl(event.data.detail, origin);
		if (url) openExternal(url);
	};
	for (const name of names) events.on(name, onNavigation);
	return () => {
		for (const name of names) events.off(name, onNavigation);
	};
}
