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
import { selectFileBufferSummary, useAppStore } from "../store";

interface PendingClose {
	workspaceId: string;
	path: string;
	close: () => void;
}

export function useFileCloseGuard(): {
	requestClose: (file: { workspaceId: string; path: string }, close: () => void) => void;
	confirmation: ReactNode;
} {
	const t = useT();
	const [pending, setPendingState] = useState<PendingClose | null>(null);
	const pendingRef = useRef<PendingClose | null>(null);
	const [savingRequest, setSavingRequest] = useState<PendingClose | null>(null);
	const setPending = (next: PendingClose | null) => {
		pendingRef.current = next;
		setPendingState(next);
	};
	const requestClose = (file: { workspaceId: string; path: string }, close: () => void) => {
		const summary = selectFileBufferSummary(useAppStore.getState(), file.workspaceId, file.path);
		if (summary?.dirty === true) setPending({ ...file, close });
		else close();
	};
	const save = async (request: PendingClose) => {
		setSavingRequest(request);
		const summary = await saveFile(request.workspaceId, request.path).catch(() => null);
		setSavingRequest((current) => (current === request ? null : current));
		if (pendingRef.current !== request) return;
		setPending(null);
		if (summary?.status === "clean") request.close();
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
