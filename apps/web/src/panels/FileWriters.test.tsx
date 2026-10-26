import { afterEach, expect, test } from "bun:test";
import type { WorkspaceFsChangedPayload } from "@thinkrail/contracts";
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
	useAppStore.setState({ fileActivityByWorkspace: {}, removedWorkspaceIds: {} });
	for (let index = 1; index <= count; index++)
		useAppStore.getState().noteFsChanged(frame(`s${index}`));
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
