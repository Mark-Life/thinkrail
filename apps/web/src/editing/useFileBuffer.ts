import type { ResourceMeta } from "@thinkrail/contracts";
import { useCallback, useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import { loadBufferRegistry, loadedBufferRegistry, subscribeBufferRegistry } from "./files";
import { fileBufferKey } from "./keys";
import type { FileBufferHandle } from "./registry";

const NO_SUBSCRIPTION = () => () => {};

export function useFileBuffer(
	file: { workspaceId: string; path: string; content: string; meta?: ResourceMeta | undefined },
	editable: boolean,
): FileBufferHandle | null {
	const registry = useSyncExternalStore(subscribeBufferRegistry, loadedBufferRegistry);
	const key = fileBufferKey(file.workspaceId, file.path);
	const handle = useSyncExternalStore(registry?.subscribeEntries ?? NO_SUBSCRIPTION, () =>
		registry ? registry.get(key) : null,
	);
	const { workspaceId, path, content, meta } = file;
	useLayoutEffect(() => {
		if (!editable || !meta) return;
		if (registry) registry.ensure({ workspaceId, path, content, meta });
		else loadBufferRegistry().catch(() => {});
	}, [registry, editable, workspaceId, path, content, meta]);
	useEffect(() => (registry ? () => registry.flush(key) : undefined), [registry, key]);
	return handle;
}

export function useFileBufferText(
	handle: FileBufferHandle | null,
	enabled: boolean,
): string | null {
	const subscribe = useCallback(
		(listener: () => void) =>
			handle && enabled ? handle.subscribeText(listener) : NO_SUBSCRIPTION(),
		[handle, enabled],
	);
	return useSyncExternalStore(subscribe, () =>
		handle && enabled ? handle.session.snapshot() : null,
	);
}
