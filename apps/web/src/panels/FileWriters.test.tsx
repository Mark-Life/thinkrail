import { afterEach, expect, test } from "bun:test";
import type { FileRead, WorkspaceFsChangedPayload } from "@thinkrail/contracts";
import { TooltipProvider } from "@thinkrail/ui/tooltip";
import { renderToStaticMarkup } from "react-dom/server";
import { useAppStore } from "../store";
import { FileWriterAvatars, FileWritersChip } from "./FileWriters";

const frame = (sessionId: string): WorkspaceFsChangedPayload => ({
	workspaceId: "ws",
	paths: ["a.ts"],
	truncated: false,
	skillChange: "none",
	authors: {
		"a.ts": {
			author: { kind: "agent", sessionId, via: "tool", toolName: "edit" },
			hash: sessionId,
		},
	},
});

let restore: (() => void) | undefined;

afterEach(() => {
	restore?.();
	restore = undefined;
});

function seedWriters(count: number) {
	seedActivity(() => {
		for (let index = 1; index <= count; index++)
			useAppStore.getState().noteFsChanged(frame(`s${index}`));
	});
}

function seedActivity(fold: () => void) {
	useAppStore.setState({ fileActivityByWorkspace: {}, removedWorkspaceIds: {} });
	fold();
	const initial = useAppStore.getInitialState();
	const previous = initial.fileActivityByWorkspace;
	initial.fileActivityByWorkspace = useAppStore.getState().fileActivityByWorkspace;
	restore = () => {
		initial.fileActivityByWorkspace = previous;
	};
}

const render = (node: React.ReactNode) =>
	renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);

test("past three writers the tab avatars show how many more there are", () => {
	seedWriters(5);
	const html = render(<FileWriterAvatars workspaceId="ws" path="a.ts" />);
	expect(html.match(/data-testid="file-writer-avatar"/g)).toHaveLength(3);
	expect(html).toContain(">+2<");
	expect(html).not.toContain("tabindex");
});

test("the pane chip is a focusable button that names every writer", () => {
	seedWriters(5);
	const html = render(<FileWritersChip workspaceId="ws" path="a.ts" />);
	expect(html).toMatch(/<button type="button" data-testid="file-writers"/);
	expect(html).toContain(">+2<");
	expect(html).toContain("5 writers");
});

test("three writers or fewer show no overflow count", () => {
	seedWriters(3);
	expect(render(<FileWriterAvatars workspaceId="ws" path="a.ts" />)).not.toContain(
		"file-writer-overflow",
	);
});

test("after a reload, the last write a file read reports shows as a writer", () => {
	seedActivity(() =>
		useAppStore.getState().noteFileRead("ws", "a.ts", {
			content: "x",
			meta: { hash: "h1" } as FileRead["meta"],
			lastWrite: {
				author: { kind: "agent", sessionId: "s1", via: "tool", toolName: "edit" },
				at: Date.now() - 1_000,
			},
		}),
	);
	const html = render(<FileWritersChip workspaceId="ws" path="a.ts" />);
	expect(html).toContain("1 writer");
	expect(html).toContain('data-writer="agent:s1"');
});
