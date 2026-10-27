import { CommentRefused, type SurfaceReview } from "@thinkrail/resource-renderers";

type Commenting = SurfaceReview["commenting"];

export function commentAfterSave(
	commenting: Commenting,
	{
		dirty,
		save,
		refusal,
		onComposing,
	}: {
		dirty(): boolean;
		save(): Promise<{ dirty: boolean } | null>;
		refusal(): string;
		onComposing(open: boolean): void;
	},
): Commenting {
	const saved = async () => {
		if (!dirty()) return;
		const summary = await save().catch(() => ({ dirty: true }));
		if (summary?.dirty) throw new CommentRefused(refusal());
	};
	return {
		onSave: async (draft, text) => {
			await saved();
			await commenting.onSave(draft, text);
		},
		onSend: async (draft, text) => {
			await saved();
			await commenting.onSend(draft, text);
		},
		onComposing,
	};
}

/** Review hides on unsaved text, except while a comment box is open so its text and error stay. */
export function hidesReview({
	dirty,
	autosaving,
	composing,
}: {
	dirty: boolean;
	autosaving: boolean;
	composing: boolean;
}) {
	return dirty && !autosaving && !composing;
}
