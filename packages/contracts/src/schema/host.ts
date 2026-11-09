import {
	arr,
	bool,
	num,
	oneOf,
	opt,
	type Schema,
	type Static,
	str,
} from "@earendil-works/pi-schema";
import { Project } from "./project";
import { AppConfig } from "./settings";
import { SpeechStatus } from "./speech";
import { Ack, NoParams, wireObj } from "./wire";

/** Raised only for a breaking wire change. A UI and a host must hold the same value. */
export const PROTOCOL_VERSION = 108;

export const HostPlatform = oneOf(["darwin", "linux", "win32"]);
export type HostPlatform = Static<typeof HostPlatform>;

const HostUpdateStatus = oneOf(["available", "running", "succeeded", "failed"]);

export const HostUpdateNotice = wireObj({
	currentVersion: str(),
	availableVersion: str(),
	channel: str(),
	status: opt(HostUpdateStatus),
});
export type HostUpdateNotice = Static<typeof HostUpdateNotice>;

export const ServerWelcome = wireObj({
	protocolVersion: num(),
	appVersion: opt(str()),
	hostPlatform: opt(HostPlatform),
	hostUpdate: opt(HostUpdateNotice),
	configReadFailed: opt(bool()),
	projects: arr(Project),
	recentProjects: arr(Project),
	config: AppConfig,
	/** Voice input state; later changes arrive on `speech.changed`. */
	speech: opt(SpeechStatus),
});
export type ServerWelcome = Static<typeof ServerWelcome>;

function bareObject<T>(): Schema<T> {
	return { type: "object" };
}

/** All a client reads from a welcome before it knows the host speaks its version. */
export const HostWelcomeVersions = wireObj({ protocolVersion: num() });
export type HostWelcomeVersions = Static<typeof HostWelcomeVersions>;

/** What a client needs from the welcome of a host at its own version. */
export const AnyHostWelcome = wireObj({
	protocolVersion: num(),
	appVersion: opt(str()),
	hostPlatform: opt(str()),
	hostUpdate: opt(bareObject<HostUpdateNotice>()),
	configReadFailed: opt(bool()),
	projects: arr(bareObject<Project>()),
	recentProjects: opt(arr(bareObject<Project>())),
	config: opt(bareObject<AppConfig>()),
	speech: opt(bareObject<SpeechStatus>()),
});
export type AnyHostWelcome = Static<typeof AnyHostWelcome>;

export const HOST_METHODS = {
	"host.update": { params: NoParams, result: Ack },
};

export const HOST_CHANNELS = {
	"server.welcome": ServerWelcome,
	"host.updateAvailable": HostUpdateNotice,
};
