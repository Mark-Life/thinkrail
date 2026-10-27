import { expect, test } from "bun:test";
import { type AnchorDraft, CommentRefused } from "@thinkrail/resource-renderers";
import { commentAfterSave, hidesReview } from "./commentAfterSave";

const draft: AnchorDraft = {
	selectors: [{ kind: "lineRange", startLine: 5, endLine: 5 }],
	label: "Line 5",
};

function harness({
	dirty,
	save,
}: {
	dirty: boolean;
	save: () => Promise<{ dirty: boolean } | null>;
}) {
	const log: string[] = [];
	const commenting = commentAfterSave(
		{
			onSave: async () => {
				log.push("add");
			},
			onSend: async () => {
				log.push("send");
			},
		},
		{
			dirty: () => dirty,
			save: () => {
				log.push("save");
				return save();
			},
			refusal: () => "the file's edits could not be saved",
			onComposing: (open) => log.push(open ? "open" : "closed"),
		},
	);
	return { commenting, log };
}

test("a comment on a dirty buffer is added only after the buffer is saved", async () => {
	const { commenting, log } = harness({ dirty: true, save: async () => ({ dirty: false }) });
	await commenting.onSave(draft, "body");
	await commenting.onSend(draft, "body");
	expect(log).toEqual(["save", "add", "save", "send"]);
});

test("a failed save refuses the comment with a message for its box, and a retry can add it", async () => {
	let saved = { dirty: true };
	const { commenting, log } = harness({ dirty: true, save: async () => saved });
	const refusal = commenting.onSave(draft, "body");
	await expect(refusal).rejects.toBeInstanceOf(CommentRefused);
	await expect(refusal).rejects.toThrow("the file's edits could not be saved");
	await expect(commenting.onSend(draft, "body")).rejects.toBeInstanceOf(CommentRefused);
	saved = { dirty: false };
	await commenting.onSave(draft, "body");
	expect(log).toEqual(["save", "save", "save", "add"]);
});

test("a save that throws refuses the comment the same way", async () => {
	const { commenting } = harness({
		dirty: true,
		save: () => Promise.reject(new Error("socket closed")),
	});
	await expect(commenting.onSave(draft, "body")).rejects.toBeInstanceOf(CommentRefused);
});

test("a clean buffer adds the comment with no save", async () => {
	const { commenting, log } = harness({ dirty: false, save: async () => null });
	await commenting.onSave(draft, "body");
	expect(log).toEqual(["add"]);
});

test("the composer's open state reaches the pane", () => {
	const { commenting, log } = harness({ dirty: false, save: async () => null });
	commenting.onComposing?.(true);
	commenting.onComposing?.(false);
	expect(log).toEqual(["open", "closed"]);
});

test("review stays shown on unsaved text while a comment box is open", () => {
	expect(hidesReview({ dirty: true, autosaving: false, composing: false })).toBe(true);
	expect(hidesReview({ dirty: true, autosaving: false, composing: true })).toBe(false);
	expect(hidesReview({ dirty: true, autosaving: true, composing: false })).toBe(false);
	expect(hidesReview({ dirty: false, autosaving: false, composing: false })).toBe(false);
});
