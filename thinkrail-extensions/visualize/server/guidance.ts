import { MOCKUP_CDN_SOURCES, MOCKUP_THEME_CHANGE_EVENT } from "@thinkrail/extension-api/server";
import { THEME_FILE_NAME } from "./themeFile";

function libraryRule(cdnSources: readonly string[]): string {
	if (cdnSources.length === 0) return "no library loads from a URL, so inline what you need";
	const prefixes = cdnSources.map((source) => `\`${source}\``).join(", ");
	return `a library loads only from ${prefixes}, with an exact version in the URL`;
}

export function mockupGuideline(
	scratchDir: string,
	cdnSources: readonly string[] = MOCKUP_CDN_SOURCES,
): string {
	return [
		`write a self-contained HTML file under \`${scratchDir}\` and link the theme file \`${scratchDir}${THEME_FILE_NAME}\` from it with a relative href (\`<link rel="stylesheet" href="${THEME_FILE_NAME}">\` from a file next to it).`,
		"Read that file for the token names; link it, do not copy it in.",
		"Colour everything with its `var(--…)` tokens instead of fixed colours and leave the page background to the theme.",
		"Inline all data and images (`data:` URLs): a file next to the mockup does not load.",
		"Some clients run no script and load nothing from a URL: there scripts and handlers are removed, a CDN file does not load, and a `<form>` is dropped with everything in it.",
		"So the mockup must look complete with no script and no CDN file: put controls directly in the page with no `<form>`, write all your own CSS in the file itself (a CDN file may only add what a script draws), and draw a static version of anything a script draws as normal markup that the script replaces when it runs.",
		"Do not put that static version in `<noscript>`: it stays hidden where scripts run, also when a library does not load.",
		`Where scripts run, inline scripts and handlers work, and ${libraryRule(cdnSources)}.`,
		"Do not use fetch, XHR, WebSocket, workers, `eval`, `new Function`, `localStorage`, cookies, `alert`, form submit, links, navigation or `document.write` after load: they are blocked or close the mockup.",
		"Do not call `history.pushState` or set `location.hash` (no hash router, no hash tabs): each call adds an entry to the app tab's history, and Back then steps through the mockup instead of the app.",
		"WebAssembly runs only from inline bytes.",
		"Do not call `scrollIntoView()`, call `focus()` only in a handler of a user action, and do not cancel the Tab key: they take the chat scroll position or the keyboard away from the user.",
		`A script that reads token colours redraws on the window's \`${MOCKUP_THEME_CHANGE_EVENT}\` event.`,
		"Draw a dialog, drawer, toast or open dropdown in normal flow, or give `body` a pixel `min-height` that holds it: a `position: fixed` layer adds no height to the card, and neither does an absolutely positioned panel that opens after load (in a `details`, on `:hover`).",
		"Let the content set the height (no `vh` units, no `height: 100%` on html/body)",
	].join(" ");
}
