interface TextForm {
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

function encode(body: string, bom: boolean): Uint8Array {
	return BYTES.encode(bom || body.startsWith("\uFEFF") ? `\uFEFF${body}` : body);
}

export function applyForm(editorText: string, form: TextForm): Uint8Array {
	const lf = editorText.replace(/\r\n?/g, "\n");
	return encode(form.eol === "\r\n" ? lf.replaceAll("\n", "\r\n") : lf, form.bom);
}

export function createdBytes(editorText: string): Uint8Array {
	return encode(editorText, false);
}
