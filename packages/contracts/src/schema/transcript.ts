import type { Message, ImageContent as PiImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	arr,
	bool,
	lit,
	num,
	opt,
	type Schema,
	type Static,
	str,
	union,
	unknown,
} from "@earendil-works/pi-schema";
import { piOwned, wireObj } from "./wire";

export const ImageContent: Schema<PiImageContent> = wireObj({
	type: lit("image"),
	data: str(),
	mimeType: str(),
});
export type ImageContent = Static<typeof ImageContent>;

export const WireCustomMessage = wireObj({
	role: lit("custom"),
	customType: str(),
	content: union([str(), arr(union([piOwned<TextContent>(), ImageContent]))]),
	display: bool(),
	details: opt(unknown()),
	timestamp: num(),
});
export type WireCustomMessage<T = unknown> = Omit<Static<typeof WireCustomMessage>, "details"> & {
	details?: T;
};

export const WireCompactionSummary = wireObj({
	role: lit("compactionSummary"),
	summary: str(),
	tokensBefore: num(),
	timestamp: num(),
});
export type WireCompactionSummary = Static<typeof WireCompactionSummary>;

export const TranscriptMessage = union([
	piOwned<Message>(),
	WireCustomMessage,
	WireCompactionSummary,
]);
export type TranscriptMessage = Static<typeof TranscriptMessage>;
