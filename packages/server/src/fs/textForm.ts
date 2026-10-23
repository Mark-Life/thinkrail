export interface TextForm {
	bom: boolean;
	eol: "\n" | "\r\n";
}

const BYTES = new TextEncoder();
const LF = 0x0a;
const CR = 0x0d;

function hasBom(bytes: Uint8Array): boolean {
	return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

export function textForm(bytes: Uint8Array): TextForm {
	const firstBreak = bytes.indexOf(LF);
	return {
		bom: hasBom(bytes),
		eol: firstBreak > 0 && bytes[firstBreak - 1] === CR ? "\r\n" : "\n",
	};
}

export function applyForm(editorText: string, form: TextForm): Uint8Array {
	const body = form.eol === "\r\n" ? editorText.replaceAll("\n", "\r\n") : editorText;
	return BYTES.encode(form.bom ? `﻿${body}` : body);
}
