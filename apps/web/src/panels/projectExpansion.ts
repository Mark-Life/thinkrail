import { type ProjectId, parseStoredProjectId } from "@thinkrail/contracts";
import { STORAGE_PREFIX } from "../constants/branding";
import { useAppStore } from "../store";
import { getTransport, reportHandledFailure } from "../transport";

function storageKey(): string {
	return `${STORAGE_PREFIX}expanded-projects:${getTransport().httpBase()}`;
}

function readPersistedExpansion(): ProjectId[] {
	try {
		const raw = localStorage.getItem(storageKey());
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.map(parseStoredProjectId).filter((id) => id !== null);
	} catch {
		return [];
	}
}

function persistExpansion(expanded: Record<string, true>): void {
	try {
		localStorage.setItem(storageKey(), JSON.stringify(Object.keys(expanded)));
	} catch (error) {
		reportHandledFailure("project-expansion-write", error, "STATE_FILE_WRITE_FAILED");
	}
}

export function initProjectExpansionPersistence(): void {
	useAppStore.getState().hydrateExpandedProjects(readPersistedExpansion());
	let previous = useAppStore.getState().expandedProjectIds;
	useAppStore.subscribe((state) => {
		if (state.expandedProjectIds === previous) return;
		previous = state.expandedProjectIds;
		persistExpansion(previous);
	});
}
