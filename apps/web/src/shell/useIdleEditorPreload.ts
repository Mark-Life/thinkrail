import {
	describeResource,
	PENDING_TEXT_META,
	usePreloadResourceView,
} from "@thinkrail/resource-renderers";
import { useEffect } from "react";
import { isRecord, usePhoneViewport, whenIdle } from "../lib";

const IDLE_TIMEOUT_MS = 2000;
const FALLBACK_DELAY_MS = 1500;

function savesData(): boolean {
	const connection: unknown = Reflect.get(navigator, "connection");
	return isRecord(connection) && connection.saveData === true;
}

export function useIdleEditorPreload(workspaceId: string): void {
	const preload = usePreloadResourceView();
	const phone = usePhoneViewport();
	useEffect(() => {
		if (phone || savesData()) return;
		return whenIdle(() => preload(describeResource(workspaceId, "", PENDING_TEXT_META)), {
			timeout: IDLE_TIMEOUT_MS,
			fallbackDelay: FALLBACK_DELAY_MS,
		});
	}, [phone, preload, workspaceId]);
}
