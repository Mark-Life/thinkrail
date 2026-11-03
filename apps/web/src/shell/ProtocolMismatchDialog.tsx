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
import { useAppStore } from "../store";

export function ProtocolMismatchDialog() {
	const t = useT();
	const mismatch = useAppStore((state) => state.protocolMismatch);
	if (!mismatch) return null;
	const uiOutdated = mismatch === "uiOutdated";

	return (
		<Dialog open>
			<DialogContent
				hideClose
				data-testid="protocol-mismatch-dialog"
				data-mismatch={mismatch}
				className="max-w-[30rem] gap-16"
			>
				<DialogHeader>
					<DialogTitle>
						{uiOutdated
							? t("shell.protocolMismatch.uiTitle")
							: t("shell.protocolMismatch.hostTitle")}
					</DialogTitle>
					<DialogDescription>
						{uiOutdated ? t("shell.protocolMismatch.uiBody") : t("shell.protocolMismatch.hostBody")}
					</DialogDescription>
				</DialogHeader>
				{uiOutdated ? (
					<DialogFooter>
						<Button data-testid="protocol-mismatch-reload" onClick={() => window.location.reload()}>
							{t("shell.protocolMismatch.reload")}
						</Button>
					</DialogFooter>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
