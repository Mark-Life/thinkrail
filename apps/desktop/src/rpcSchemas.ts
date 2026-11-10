import {
	bool,
	compile,
	lit,
	map,
	num,
	obj,
	oneOf,
	opt,
	type Schema,
	type Static,
	str,
	union,
	unknown,
} from "@earendil-works/pi-schema";
import type { NativeNotificationInput, Same } from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import { desktopError } from "./errorReporting";

const OPEN = { open: true };

export const RouteChange = obj({ hash: str() }, OPEN);
export type RouteChange = Static<typeof RouteChange>;

export const PreferenceWrite = obj({ key: str(), value: str() }, OPEN);
export type PreferenceWrite = Static<typeof PreferenceWrite>;

export const PreferenceRemove = obj({ key: str() }, OPEN);
export type PreferenceRemove = Static<typeof PreferenceRemove>;

export const PageZoomRequest = obj({ action: oneOf(["in", "out", "reset"]) }, OPEN);
export type PageZoomRequest = Static<typeof PageZoomRequest>;
export type PageZoomAction = PageZoomRequest["action"];

export const PageZoomGesture = union([
	obj({ phase: lit("start") }, OPEN),
	obj({ phase: lit("change"), scale: num({ exclusiveMinimum: 0 }) }, OPEN),
	obj({ phase: lit("end") }, OPEN),
]);
export type PageZoomGesture = Static<typeof PageZoomGesture>;

export const MenuLabelsChange = obj({ labels: map(unknown()) }, OPEN);
export type MenuLabelsChange = Static<typeof MenuLabelsChange>;

export const NotificationRequest = obj(
	{ title: str(), subtitle: opt(str()), body: str(), silent: opt(bool()) },
	OPEN,
);
export type NotificationRequest = Same<Static<typeof NotificationRequest>, NativeNotificationInput>;

export function checked<T>(name: string, schema: Schema<T>, handle: (payload: T) => void) {
	const validator = compile(schema);
	return (payload: unknown): undefined => {
		if (validator.check(payload)) handle(payload);
		else
			desktopError(
				"rpc",
				`refused a malformed ${name}`,
				new CodedError("NATIVE_RPC_INVALID", `malformed ${name}`),
			);
	};
}
