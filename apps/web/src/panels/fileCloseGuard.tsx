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
import { type ReactNode, useState } from "react";
import { discardFile, isFileDirty, saveFile } from "../editing";
import { fileName } from "../lib";

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
	const [pending, setPending] = useState<PendingClose | null>(null);
	const [saving, setSaving] = useState(false);
	const requestClose = (file: { workspaceId: string; path: string }, close: () => void) => {
		if (isFileDirty(file.workspaceId, file.path)) setPending({ ...file, close });
		else close();
	};
	const save = async (request: PendingClose) => {
		setSaving(true);
		const summary = await saveFile(request.workspaceId, request.path).catch(() => null);
		setSaving(false);
		setPending(null);
		if (summary?.status === "clean") request.close();
	};
	const discard = (request: PendingClose) => {
		setPending(null);
		discardFile(request.workspaceId, request.path);
		request.close();
	};
	return {
		requestClose,
		confirmation: (
			<Dialog
				open={pending !== null}
				onOpenChange={(open) => {
					if (!open && !saving) setPending(null);
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
						<Button variant="outline" disabled={saving} onClick={() => setPending(null)}>
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
							{t("panels.fileCloseGuard.save")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		),
	};
}
