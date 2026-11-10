import { compile, obj, type Static, str } from "@earendil-works/pi-schema";
import { RiPencilLine as Pencil } from "@remixicon/react";
import type { Same, ToolInputs } from "@thinkrail/contracts";
import { listArg, resultText, strArg, type ToolRenderProps } from "@thinkrail/extension-api/web";
import { useT } from "@thinkrail/locales/react";
import { Collapsible } from "./Collapsible";
import { ToolFileLink } from "./ToolFileLink";

type Input = ToolInputs["edit"];
/** The pre-`edits` form pi's edit tool still accepts and folds into `edits`; pi exports no type for it. */
interface LegacyInput {
	oldText: string;
	newText: string;
}

const Replacement = obj({ oldText: str(), newText: str() }, { open: true });
type Replacement = Same<Static<typeof Replacement>, Input["edits"][number]>;
const isReplacement = compile(Replacement).check;

function replacementsOf(args: Record<string, unknown>): Replacement[] {
	const edits = listArg<Input>(args, "edits").filter(isReplacement);
	if (edits.length > 0) return edits;
	const oldText = strArg<LegacyInput>(args, "oldText");
	const newText = strArg<LegacyInput>(args, "newText");
	return oldText || newText ? [{ oldText, newText }] : [];
}

const linesOf = (text: string) => (text ? text.split("\n") : []);

export function EditCard({
	toolCallId,
	args,
	result,
	status,
	workspaceRoot,
	onOpenFile,
}: ToolRenderProps) {
	const path = strArg<Input>(args, "path");
	const replacements = replacementsOf(args);
	const message = resultText(result);

	if (status === "error") {
		return (
			<div data-testid="tool-edit" className="flex flex-col gap-4">
				<EditHeader
					path={path}
					workspaceRoot={workspaceRoot}
					onOpenFile={onOpenFile}
					disabled={true}
				/>
				<pre className="overflow-auto px-8 py-4 text-feedback-error tr-code-text">{message}</pre>
			</div>
		);
	}

	const lineCount = replacements.reduce(
		(sum, { oldText, newText }) => sum + linesOf(oldText).length + linesOf(newText).length,
		0,
	);

	return (
		<div data-testid="tool-edit" className="flex flex-col gap-4">
			<EditHeader
				path={path}
				workspaceRoot={workspaceRoot}
				onOpenFile={onOpenFile}
				disabled={status !== "done"}
			/>
			<Collapsible
				id={`${toolCallId}:content`}
				lines={lineCount}
				fadeClass="bg-[linear-gradient(to_top,var(--container-elevated-bg),transparent)]"
			>
				<div className="overflow-auto rounded-sm border border-border-default tr-code-text leading-relaxed">
					{replacements.map(({ oldText, newText }, edit) => {
						const key = `edit-${edit}`;
						return (
							<div key={key} className={edit > 0 ? "border-t border-border-default" : undefined}>
								{linesOf(oldText).map((line, i) => {
									const key = `old-${i}`;
									return (
										<div key={key} className="flex bg-feedback-error-subtle">
											<span className="w-24 shrink-0 select-none px-4 text-right text-feedback-error-muted">
												−
											</span>
											<pre className="min-w-0 flex-1 px-4 text-feedback-error tr-code-text">
												{line}
											</pre>
										</div>
									);
								})}
								{linesOf(newText).map((line, i) => {
									const key = `new-${i}`;
									return (
										<div key={key} className="flex bg-feedback-success-subtle">
											<span className="w-24 shrink-0 select-none px-4 text-right text-feedback-success-muted">
												+
											</span>
											<pre className="min-w-0 flex-1 px-4 text-feedback-success tr-code-text">
												{line}
											</pre>
										</div>
									);
								})}
							</div>
						);
					})}
				</div>
			</Collapsible>
		</div>
	);
}

function EditHeader({
	path,
	workspaceRoot,
	onOpenFile,
	disabled,
}: {
	path: string;
	workspaceRoot?: string | undefined;
	onOpenFile?: ((path: string) => void) | undefined;
	disabled: boolean;
}) {
	const t = useT();
	return (
		<div className="flex items-center gap-4 tr-text-metadata">
			<Pencil className="size-12 shrink-0 text-feedback-warning" />
			<ToolFileLink
				path={path}
				workspaceRoot={workspaceRoot}
				onOpenFile={onOpenFile}
				disabled={disabled}
				className="text-text-default"
			/>
			<span className="shrink-0 text-text-muted">{t("tools.edit.edited")}</span>
		</div>
	);
}
