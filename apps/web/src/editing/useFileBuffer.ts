import type { ResourceMeta } from "@thinkrail/contracts";
import { useCallback, useLayoutEffect, useSyncExternalStore } from "react";
import { bufferRegistry } from "./files";
import { type FileBufferHandle, fileBufferKey } from "./registry";

const NO_SUBSCRIPTION = () => () => {};

export function useFileBuffer(
	file: { workspaceId: string; path: string; content: string; meta?: ResourceMeta | undefined },
	editable: boolean,
): FileBufferHandle | null {
	const registry = bufferRegistry();
	const key = fileBufferKey(file.workspaceId, file.path);
	const handle = useSyncExternalStore(registry.subscribeEntries, () => registry.get(key));
	const { workspaceId, path, content, meta } = file;
	useLayoutEffect(() => {
		if (editable && meta) registry.ensure({ workspaceId, path, content, meta });
	}, [registry, editable, workspaceId, path, content, meta]);
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
