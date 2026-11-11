import {
	ACCEPTED_IMAGE_TYPES,
	type ImageContent,
	isImageContent,
	isTextContent,
} from "@thinkrail/contracts";

const acceptedImageTypes = new Set(ACCEPTED_IMAGE_TYPES);

export interface ParsedToolResultContent {
	text: string;
	images: ImageContent[];
}

export function toolValueText(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

export function parseToolResultContent(result: unknown): ParsedToolResultContent {
	if (result == null || typeof result === "string") {
		return { text: toolValueText(result), images: [] };
	}
	if (typeof result !== "object" || !("content" in result)) {
		return { text: toolValueText(result), images: [] };
	}

	const content: unknown = result.content;
	if (!Array.isArray(content)) {
		return { text: toolValueText(result), images: [] };
	}

	const blocks: readonly unknown[] = content;
	const text: string[] = [];
	const images: ImageContent[] = [];
	for (const block of blocks) {
		if (isTextContent(block)) {
			text.push(block.text);
			continue;
		}
		if (isImageContent(block) && block.data.length > 0 && acceptedImageTypes.has(block.mimeType)) {
			images.push({ type: "image", data: block.data, mimeType: block.mimeType });
		}
	}
	return { text: text.join(""), images };
}
