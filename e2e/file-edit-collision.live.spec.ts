import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { WS_CHANNELS } from "@thinkrail/contracts";
import { openWorkspaceChat } from "./fixtures/app";
import { E2eWire } from "./fixtures/wire";

interface ToolEnd {
	toolName: string;
	isError: boolean;
	text: string;
}

function toolEnd(data: unknown): ToolEnd | null {
	const event = (data as { event?: Record<string, unknown> } | null)?.event;
	if (event?.type !== "tool_execution_end" || typeof event.toolName !== "string") return null;
	const content = (event.result as { content?: unknown } | undefined)?.content;
	const text = Array.isArray(content)
		? content
				.flatMap((part) => (typeof part?.text === "string" ? [part.text as string] : []))
				.join("\n")
		: "";
	return { toolName: event.toolName, isError: event.isError === true, text };
}

test("a user save between the agent's read and edit reaches the agent as a ThinkRail hint", {
	tag: "@agent",
}, async ({ page }) => {
	test.setTimeout(240_000);
	const workspace = await openWorkspaceChat(page);
	const token = `tok-${Date.now().toString(36)}`;
	const path = "collision.txt";
	writeFileSync(join(workspace.worktreePath, path), `name = demo\ntoken = ${token}\nend = true\n`);

	const wire = await E2eWire.connect(Number(new URL(page.url()).port));
	try {
		const readDone = wire.push(
			WS_CHANNELS.piEvent,
			(data) => {
				const end = toolEnd(data);
				return end?.toolName === "read" && end.text.includes(token);
			},
			180_000,
		);
		const editDone = wire.push(
			WS_CHANNELS.piEvent,
			(data) => toolEnd(data)?.toolName === "edit",
			240_000,
		);
		await page
			.getByTestId("chat-input")
			.fill(
				`Use the read tool to read ${path}. Then use the edit tool once to change the line that starts with "token = " so its value becomes done, copying the old line exactly from what you read. Do not use any other tool and do not read the file again before that edit.`,
			);
		await page.getByTestId("chat-send").click();

		await readDone;
		const target = { workspaceId: workspace.id, path };
		const before = await wire.request("fs.readFile", target);
		const saved = await wire.request("fs.writeFile", {
			...target,
			content: before.content.replace(`token = ${token}`, "token = changed-by-user"),
			expect: { hash: before.meta.hash },
		});
		expect(saved.status).toBe("written");

		const edit = toolEnd(await editDone);
		expect(edit?.isError).toBe(true);
		expect(edit?.text).toMatch(
			/ThinkRail: \S*collision\.txt was changed by the user \d+ s ago \(line 2\)/,
		);
		expect(edit?.text).toContain(`-token = ${token}`);
		expect(edit?.text).toContain("+token = changed-by-user");
	} finally {
		wire.close();
	}
});
