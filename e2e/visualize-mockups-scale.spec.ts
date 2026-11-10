import { expect, test } from "@playwright/test";
import { clickInTranscriptFrame } from "./fixtures/chatScroll";
import {
	installDesktopShellMarker,
	MOCKUP_DIR,
	openVisualization,
	writeMockups,
} from "./fixtures/visualize";

test.use({ launchOptions: { args: ["--force-device-scale-factor=0.9"] } });

const mockup = `<!doctype html><html><head><style>
body { margin: 0; } #block { height: 186px; } summary { display: block; height: 20px; overflow: hidden; }
#one .more { height: 85px; } #two .more { height: 126px; }
</style></head><body><div id="block"></div>
<details id="one"><summary>One</summary><div class="more"></div></details>
<details id="two"><summary>Two</summary><div class="more"></div></details></body></html>`;

for (const mode of ["themed", "scripted"] as const) {
	test(`a ${mode} mockup card fits and follows its document at a fractional layout scale`, async ({
		page: app,
	}) => {
		if (mode === "themed") await installDesktopShellMarker(app);
		const cleanup = writeMockups({ "scaled.html": mockup });
		try {
			const card = await openVisualization(app, `scaled ${mode} mockup`, {
				type: "file",
				path: `${MOCKUP_DIR}/scaled.html`,
			});
			const preview = card.getByTestId("resource-preview");
			await expect(preview.getByTestId("html-view")).toHaveAttribute("data-html-mode", mode);
			const box = preview.getByTestId("html-frame-box");
			const frame = preview.frameLocator("iframe");
			for (const [open, height] of [
				[null, 226],
				["#one", 311],
				["#two", 437],
			] as const) {
				if (open) await clickInTranscriptFrame(frame.locator(`${open} summary`));
				await expect
					.poll(async () =>
						Math.abs(Number(await box.getAttribute("data-content-height")) - height),
					)
					.toBeLessThanOrEqual(1);
				await expect(preview).toHaveAttribute("data-natural-height", "true");
			}
		} finally {
			cleanup();
		}
	});
}
