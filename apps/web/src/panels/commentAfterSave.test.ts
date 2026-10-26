import { expect, test } from "bun:test";
import type { AnchorDraft } from "@thinkrail/resource-renderers";
import { commentAfterSave } from "./commentAfterSave";

const draft: AnchorDraft = {
	selectors: [{ kind: "lineRange", startLine: 5, endLine: 5 }],
	label: "Line 5",
};

function harness({ dirty, savedDirty }: { dirty: boolean; savedDirty: boolean }) {
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
			save: async () => {
				log.push("save");
				return { dirty: savedDirty };
			},
			refused: () => log.push("refused"),
		},
	);
	return { commenting, log };
}

test("a comment on a dirty buffer is added only after the buffer is saved", async () => {
	const { commenting, log } = harness({ dirty: true, savedDirty: false });
	await commenting.onSave(draft, "body");
	await commenting.onSend(draft, "body");
	expect(log).toEqual(["save", "add", "save", "send"]);
});

test("a comment is refused when the buffer stays dirty after the save", async () => {
	const { commenting, log } = harness({ dirty: true, savedDirty: true });
	await expect(commenting.onSave(draft, "body")).rejects.toThrow();
	await expect(commenting.onSend(draft, "body")).rejects.toThrow();
	expect(log).toEqual(["save", "refused", "save", "refused"]);
});

test("a clean buffer adds the comment with no save", async () => {
	const { commenting, log } = harness({ dirty: false, savedDirty: false });
	await commenting.onSave(draft, "body");
	expect(log).toEqual(["add"]);
});
