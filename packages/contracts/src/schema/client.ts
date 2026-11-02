import { map, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import { Ack, wireObj } from "./wire";

export const ClientErrorKind = oneOf(["render", "window", "rejection"]);
export type ClientErrorKind = Static<typeof ClientErrorKind>;

export const ClientErrorReport = wireObj({
	kind: ClientErrorKind,
	type: str(),
	stack: opt(str()),
	boundary: opt(str()),
	chunkIds: opt(map(str())),
});
export type ClientErrorReport = Static<typeof ClientErrorReport>;

export const CLIENT_METHODS = {
	"client.reportError": { params: ClientErrorReport, result: Ack },
};
