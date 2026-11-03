import {
	arr,
	bool,
	lit,
	map,
	nul,
	nullable,
	oneOf,
	opt,
	type Static,
	str,
	union,
	unknown,
} from "@earendil-works/pi-schema";
import { SessionId } from "./ids";
import { ProviderWarning } from "./provider";
import { wireObj } from "./wire";

/** The tool call a dialog is about; absent when it is not tied to one (a command, startup, parallel calls). */
const ExtUiDialogAnchor = {
	toolCallId: opt(str()),
	/** The input that call will run with, as the asking host saw it — shown in full inside the prompt. */
	toolInput: opt(map(unknown())),
};

export const ExtUiDialogRequest = union([
	wireObj({
		id: str(),
		sessionId: SessionId,
		kind: lit("select"),
		title: str(),
		options: arr(str()),
		...ExtUiDialogAnchor,
	}),
	wireObj({
		id: str(),
		sessionId: SessionId,
		kind: lit("confirm"),
		title: str(),
		message: str(),
		...ExtUiDialogAnchor,
	}),
	wireObj({
		id: str(),
		sessionId: SessionId,
		kind: lit("input"),
		title: str(),
		placeholder: opt(str()),
		...ExtUiDialogAnchor,
	}),
	wireObj({
		id: str(),
		sessionId: SessionId,
		kind: lit("editor"),
		title: str(),
		prefill: opt(str()),
		...ExtUiDialogAnchor,
	}),
]);

export const ExtUiRequest = union([
	ExtUiDialogRequest,
	wireObj({
		id: str(),
		sessionId: SessionId,
		kind: lit("notify"),
		message: str(),
		level: oneOf(["info", "warning", "error"]),
	}),
	wireObj({
		id: str(),
		sessionId: SessionId,
		kind: lit("setStatus"),
		key: str(),
		text: nullable(str()),
	}),
	wireObj({
		id: str(),
		sessionId: SessionId,
		kind: lit("setWidget"),
		key: str(),
		content: nullable(arr(str())),
	}),
	wireObj({ id: str(), sessionId: SessionId, kind: lit("setTitle"), title: str() }),
	wireObj({ id: str(), sessionId: SessionId, kind: lit("notice"), notice: ProviderWarning }),
	wireObj({ id: str(), sessionId: SessionId, kind: lit("dismiss") }),
]);
export type ExtUiRequest = Static<typeof ExtUiRequest>;

export const ExtUiResponse = wireObj({ id: str(), value: union([str(), bool(), nul()]) });
export type ExtUiResponse = Static<typeof ExtUiResponse>;

export const EXT_UI_CHANNELS = {
	"pi.extensionUi": ExtUiRequest,
};
