import { expect, test } from "bun:test";
import { FILE_SAVE_MODE_PROTOCOL_VERSION } from "@thinkrail/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { AUTOSAVE_DELAY_MS } from "@/editing";
import { platformShortcutLabel } from "@/lib";
import { FileSaveModeSwitch } from "./FileSaveModeSettings";

const render = (protocolVersion: number | null, mode: "auto" | "manual") =>
	renderToStaticMarkup(
		<FileSaveModeSwitch protocolVersion={protocolVersion} mode={mode} onSelect={() => {}} />,
	);

test("the autosave switch is hidden from a host that cannot store the save mode", () => {
	expect(render(FILE_SAVE_MODE_PROTOCOL_VERSION - 1, "auto")).toBe("");
	expect(render(null, "auto")).toBe("");
});

test("the autosave switch follows the host's file save mode", () => {
	expect(render(FILE_SAVE_MODE_PROTOCOL_VERSION, "auto")).toContain('aria-checked="true"');
	expect(render(FILE_SAVE_MODE_PROTOCOL_VERSION, "manual")).toContain('aria-checked="false"');
});

test("the description names the platform's save shortcut", () => {
	const html = render(FILE_SAVE_MODE_PROTOCOL_VERSION, "auto");
	expect(html).toContain(platformShortcutLabel("S"));
	expect(html).not.toContain("Cmd/Ctrl");
});

test("the description states the autosave delay the editor uses", () => {
	expect(render(FILE_SAVE_MODE_PROTOCOL_VERSION, "auto")).toContain(
		`Save edited files ${AUTOSAVE_DELAY_MS / 1000} second`,
	);
});
