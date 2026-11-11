import {
	arr,
	bool,
	lit,
	nullable,
	num,
	oneOf,
	opt,
	type Schema,
	type Static,
	str,
	union,
} from "@earendil-works/pi-schema";
import { wireObj } from "./wire";

/** The longest text one install-log field keeps. */
export const NATIVE_UPDATE_TEXT_MAX_LENGTH = 4096;
/** The most install-log entries the desktop keeps; older ones drop first. */
export const NATIVE_UPDATE_LOG_MAX_ENTRIES = 200;

const Text = str({ maxLength: NATIVE_UPDATE_TEXT_MAX_LENGTH });
const Finite = num({ minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE });
export const NativeUpdateVersion = str({ minLength: 1, maxLength: NATIVE_UPDATE_TEXT_MAX_LENGTH });
/** Epoch milliseconds. */
export const NativeUpdateTime = Finite;

/** What the web asks the desktop to show in the OS notification center. */
export const NativeNotificationInput = wireObj({
	title: str(),
	subtitle: opt(str()),
	body: opt(str()),
	silent: opt(bool()),
});
export type NativeNotificationInput = Static<typeof NativeNotificationInput>;

export const NativeUpdateLogEvent = union([
	wireObj({ kind: lit("installStarted"), version: NativeUpdateVersion }),
	wireObj({ kind: lit("hostStopping") }),
	wireObj({ kind: lit("hostStopped"), seconds: Finite }),
	wireObj({ kind: lit("handoffStarted") }),
	wireObj({ kind: lit("restarting") }),
	wireObj({ kind: lit("installed"), version: NativeUpdateVersion }),
	wireObj({ kind: lit("installFailed"), version: NativeUpdateVersion, step: Text, detail: Text }),
	wireObj({ kind: lit("diagnostic"), text: Text }),
]);
export type NativeUpdateLogEvent = Static<typeof NativeUpdateLogEvent>;

export const NativeUpdateLogEntry = wireObj({
	at: NativeUpdateTime,
	source: oneOf(["update", "host", "installer"]),
	level: oneOf(["info", "error"]),
	event: NativeUpdateLogEvent,
});
export type NativeUpdateLogEntry = Static<typeof NativeUpdateLogEntry>;

export const NativeUpdateLog: Schema<readonly NativeUpdateLogEntry[]> = arr(NativeUpdateLogEntry, {
	maxItems: NATIVE_UPDATE_LOG_MAX_ENTRIES,
});

export const NativeUpdateInstallResult = wireObj({
	outcome: oneOf(["installed", "failed", "unreported"]),
	fromVersion: nullable(Text),
	toVersion: NativeUpdateVersion,
	failedStep: nullable(Text),
	detail: nullable(Text),
	log: NativeUpdateLog,
});
export type NativeUpdateInstallResult = Static<typeof NativeUpdateInstallResult>;

export const NativeUpdateFailedPhase = nullable(oneOf(["check", "download", "install"]));
export type NativeUpdateFailedPhase = Static<typeof NativeUpdateFailedPhase>;
export const NativeUpdateInstallStep = oneOf(["stopping", "handoff", "restarting"]);
export type NativeUpdateInstallStep = Static<typeof NativeUpdateInstallStep>;

/** The desktop updater's state, as the update bridge hands it to the web. */
export const NativeUpdateState = wireObj({
	revision: num(),
	status: oneOf([
		"disabled",
		"idle",
		"checking",
		"available",
		"downloading",
		"preparing",
		"ready",
		"installing",
		"error",
	]),
	version: str(),
	channel: str(),
	availableVersion: nullable(str()),
	progress: nullable(num()),
	error: nullable(str()),
	failedPhase: NativeUpdateFailedPhase,
	installStep: nullable(NativeUpdateInstallStep),
	log: NativeUpdateLog,
	lastInstall: nullable(NativeUpdateInstallResult),
});
export type NativeUpdateState = Static<typeof NativeUpdateState>;

export const NativeWindowState = wireObj({ maximized: bool(), fullScreen: bool() });
export type NativeWindowState = Static<typeof NativeWindowState>;

export const NativeQuitHint = oneOf(["hidden", "armed", "release", "quitting"]);
export type NativeQuitHint = Static<typeof NativeQuitHint>;

export const NATIVE_COMMANDS = ["close-item", "open-settings"] as const;
export const NativeCommand = oneOf(NATIVE_COMMANDS);
export type NativeCommand = Static<typeof NativeCommand>;
