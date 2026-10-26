import { useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@thinkrail/ui/dialog";
import { type ReactNode, useRef, useState } from "react";
import { discardFile, saveFile } from "../editing";
import { fileName } from "../lib";
import { selectFileAutosaving, selectFileSaveIndicator, useAppStore } from "../store";

interface PendingClose {
	workspaceId: string;
	path: string;
	close: () => void;
}

export function closeAction(
	state: Parameters<typeof selectFileAutosaving>[0],
	{ workspaceId, path }: { workspaceId: string; path: string },
): "close" | "ask" | "saveFirst" {
	if (selectFileSaveIndicator(state, workspaceId, path) === null) return "close";
	return selectFileAutosaving(state, workspaceId, path) ? "saveFirst" : "ask";
}

export async function saveBeforeClose({
	file,
	closing,
	save,
	state,
	close,
	ask,
}: {
	file: { workspaceId: string; path: string };
	closing: Set<string>;
	save: (workspaceId: string, path: string) => Promise<unknown>;
	state: () => Parameters<typeof closeAction>[0];
	close: () => void;
	ask: () => void;
}) {
	const key = JSON.stringify([file.workspaceId, file.path]);
	if (closing.has(key)) return;
	closing.add(key);
	try {
		for (;;) {
			await save(file.workspaceId, file.path).catch(() => null);
			const action = closeAction(state(), file);
			if (action === "close") return close();
			if (action === "ask") return ask();
		}
	} finally {
		closing.delete(key);
	}
}

function revealFile({ workspaceId, path }: PendingClose) {
	const state = useAppStore.getState();
	if (state.activeWorkspaceId !== workspaceId) return;
	const tab = state.tabsByWorkspace[workspaceId]?.find(
		(candidate) => candidate.kind === "file" && candidate.path === path,
	);
	if (tab) state.setActiveTab(tab.id, "keep");
}

export function useFileCloseGuard(): {
	requestClose: (file: { workspaceId: string; path: string }, close: () => void) => void;
	confirmation: ReactNode;
} {
	const t = useT();
	const [pending, setPendingState] = useState<PendingClose | null>(null);
	const pendingRef = useRef<PendingClose | null>(null);
	const [savingRequest, setSavingRequest] = useState<PendingClose | null>(null);
	const closing = useRef(new Set<string>());
	const setPending = (next: PendingClose | null) => {
		pendingRef.current = next;
		setPendingState(next);
	};
	const requestClose = (file: { workspaceId: string; path: string }, close: () => void) => {
		const action = closeAction(useAppStore.getState(), file);
		if (action === "close") close();
		else if (action === "ask") setPending({ ...file, close });
		else
			void saveBeforeClose({
				file,
				closing: closing.current,
				save: saveFile,
				state: useAppStore.getState,
				close,
				ask: () => setPending({ ...file, close }),
			});
	};
	const save = async (request: PendingClose) => {
		setSavingRequest(request);
		const summary = await saveFile(request.workspaceId, request.path).catch(() => null);
		setSavingRequest((current) => (current === request ? null : current));
		if (pendingRef.current !== request) return;
		setPending(null);
		if (summary?.status === "clean") request.close();
		else revealFile(request);
	};
	const discard = (request: PendingClose) => {
		setPending(null);
		discardFile(request.workspaceId, request.path);
		request.close();
	};
	const saving = pending !== null && savingRequest === pending;
	return {
		requestClose,
		confirmation: (
			<Dialog
				open={pending !== null}
				onOpenChange={(open) => {
					if (!open) setPending(null);
				}}
			>
				<DialogContent
					role="alertdialog"
					className="max-w-[24rem]"
					hideClose
					data-testid="file-close-guard"
				>
					<DialogHeader>
						<DialogTitle>
							{t("panels.fileCloseGuard.title", { name: pending ? fileName(pending.path) : "" })}
						</DialogTitle>
						<DialogDescription>{t("panels.fileCloseGuard.description")}</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="outline" onClick={() => setPending(null)}>
							{t("common.cancel")}
						</Button>
						<Button
							variant="outline"
							disabled={saving}
							data-testid="file-close-discard"
							onClick={() => pending && discard(pending)}
						>
							{t("panels.fileCloseGuard.discard")}
						</Button>
						<Button
							disabled={saving}
							data-testid="file-close-save"
							onClick={() => pending && void save(pending)}
						>
							{t(saving ? "panels.fileCloseGuard.saving" : "panels.fileCloseGuard.save")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		),
	};
}
