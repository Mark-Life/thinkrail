import { expect, test } from "bun:test";
import { FILE_WRITE_PROTOCOL_VERSION } from "@thinkrail/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { FileSaveModeSwitch } from "./FileSaveModeSettings";

const render = (protocolVersion: number | null, mode: "auto" | "manual") =>
	renderToStaticMarkup(
		<FileSaveModeSwitch protocolVersion={protocolVersion} mode={mode} onSelect={() => {}} />,
	);

test("the autosave switch is hidden from a host that cannot write files", () => {
	expect(render(FILE_WRITE_PROTOCOL_VERSION - 1, "auto")).toBe("");
	expect(render(null, "auto")).toBe("");
});

test("the autosave switch follows the host's file save mode", () => {
	expect(render(FILE_WRITE_PROTOCOL_VERSION, "auto")).toContain('aria-checked="true"');
	expect(render(FILE_WRITE_PROTOCOL_VERSION, "manual")).toContain('aria-checked="false"');
});
