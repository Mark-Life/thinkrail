import { afterEach, expect, test } from "bun:test";
import type { FileRead, WorkspaceFsChangedPayload } from "@thinkrail/contracts";
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

const render = (node: React.ReactNode) => renderToStaticMarkup(node);

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
	expect(html).toContain(
		'aria-label="5 writers: changed in the last minute by Agent · s5, Agent · s4',
	);
	expect(html).toContain('aria-haspopup="dialog"');
});

test("agents read by chat title when known and by session id suffix otherwise", () => {
	seedWriters(2);
	const initial = useAppStore.getInitialState();
	const closed = initial.closedChatsByWorkspace;
	initial.closedChatsByWorkspace = { ws: [{ sessionId: "s2", title: "Fix auth", closedAt: 0 }] };
	const undo = restore;
	restore = () => {
		undo?.();
		initial.closedChatsByWorkspace = closed;
	};
	const html = render(<FileWriterAvatars workspaceId="ws" path="a.ts" />);
	expect(html).toContain('title="Fix auth"');
	expect(html).toContain('title="Agent · s1"');
	expect(html).toContain('aria-label="Changed in the last minute by Agent Fix auth, Agent · s1"');
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
