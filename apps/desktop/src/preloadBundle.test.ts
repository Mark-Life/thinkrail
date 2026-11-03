import { expect, test } from "bun:test";
import { join } from "node:path";

test("the preload bundle carries no schema compiler", async () => {
	const build = await Bun.build({
		entrypoints: [join(import.meta.dir, "preload.ts")],
		target: "browser",
		external: ["electrobun/view"],
	});
	const [output] = build.outputs;
	if (!output) throw new Error("the preload did not build");
	expect(await output.text()).not.toContain("pi-schema");
});
