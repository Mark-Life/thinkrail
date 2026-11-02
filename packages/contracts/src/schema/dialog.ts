import { nullable, str } from "@earendil-works/pi-schema";
import { NoParams, wireObj } from "./wire";

export const DIALOG_METHODS = {
	"dialog.selectDirectory": {
		params: NoParams,
		result: wireObj({ path: nullable(str()) }),
	},
};
