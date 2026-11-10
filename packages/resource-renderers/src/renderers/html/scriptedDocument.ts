import { MOCKUP_CDN_SOURCES } from "@thinkrail/contracts";
import { FRAME_BOOTSTRAP } from "./frameMessages";
import { THEME_STYLE_ATTRIBUTE } from "./htmlDocument";

function sources(...own: string[]): string {
	return [...own, ...MOCKUP_CDN_SOURCES].join(" ");
}

export const SCRIPTED_HTML_CSP = [
	"default-src 'none'",
	`script-src ${sources("'unsafe-inline'", "'wasm-unsafe-eval'")}`,
	`style-src ${sources("'unsafe-inline'")}`,
	`img-src ${sources("data:", "blob:")}`,
	`font-src ${sources("data:")}`,
	"connect-src 'none'",
	"worker-src 'none'",
	"form-action 'none'",
	"base-uri 'none'",
	"frame-src 'none'",
	"object-src 'none'",
].join("; ");

export function buildScriptedHtmlDocument(source: string, themeCss: string): string {
	const theme = themeCss.includes("<") ? "" : themeCss;
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${SCRIPTED_HTML_CSP}"><style ${THEME_STYLE_ATTRIBUTE}>${theme}</style><script>${FRAME_BOOTSTRAP}</script></head>${source}`;
}
