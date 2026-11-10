import { THEME_FILE_NAME } from "./themeFile";

export function mockupGuideline(scratchDir: string): string {
	return [
		`write a self-contained HTML file under \`${scratchDir}\` and link the theme file \`${scratchDir}${THEME_FILE_NAME}\` from it with a relative href (\`<link rel="stylesheet" href="${THEME_FILE_NAME}">\` from a file next to it).`,
		"Read that file for the token names; link it, do not copy it in.",
		"Colour everything with its `var(--…)` tokens instead of fixed colours and leave the page background to the theme.",
		"Inline all data and images (`data:` URLs): the preview loads nothing from the network.",
		"The preview removes scripts, buttons, inputs and forms, so draw controls with styled elements and show each state as static markup.",
		"Draw a dialog, drawer, toast or open dropdown in normal flow, or give `body` a pixel `min-height` that holds it: a `position: fixed` layer adds no height to the card, and neither does an absolutely positioned panel that opens after load (in a `details`, on `:hover`).",
		"Let the content set the height (no `vh` units, no `height: 100%` on html/body)",
	].join(" ");
}
