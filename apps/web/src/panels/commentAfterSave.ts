import type { SurfaceReview } from "@thinkrail/resource-renderers";

type Commenting = SurfaceReview["commenting"];

export function commentAfterSave(
	commenting: Commenting,
	{
		dirty,
		save,
		refused,
	}: {
		dirty(): boolean;
		save(): Promise<{ dirty: boolean } | null>;
		refused(): void;
	},
): Commenting {
	const saved = async () => {
		if (!dirty()) return;
		const summary = await save();
		if (!summary?.dirty) return;
		refused();
		throw new Error("The file has unsaved edits");
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
	};
}
