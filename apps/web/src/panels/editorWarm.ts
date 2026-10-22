import { type ResourceDescriptor, usePreloadResourceView } from "@thinkrail/resource-renderers";
import { isRecord, usePhoneViewport } from "../lib";

function savesData(): boolean {
	const connection: unknown = Reflect.get(navigator, "connection");
	return isRecord(connection) && connection.saveData === true;
}

export function useEditorWarm(): ((resource: ResourceDescriptor) => void) | undefined {
	const preload = usePreloadResourceView();
	const phone = usePhoneViewport();
	return phone || savesData() ? undefined : preload;
}
