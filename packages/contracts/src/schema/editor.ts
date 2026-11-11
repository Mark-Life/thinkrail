import { arr, oneOf, type Static, str } from "@earendil-works/pi-schema";
import { NoParams, wireObj } from "./wire";

export const EditorInfo = wireObj({ id: str(), label: str(), kind: oneOf(["gui", "terminal"]) });
export type EditorInfo = Static<typeof EditorInfo>;

export const EDITOR_METHODS = {
	"editor.list": { params: NoParams, result: arr(EditorInfo) },
};
