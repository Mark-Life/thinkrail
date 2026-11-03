import { arr, num, oneOf, opt, type Schema, type Static, str } from "@earendil-works/pi-schema";
import { Project } from "./project";
import { AppConfig } from "./settings";
import { Ack, NoParams, wireObj } from "./wire";

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
	protocolMin: num(),
	protocolMax: num(),
	appVersion: opt(str()),
	hostPlatform: opt(HostPlatform),
	hostUpdate: opt(HostUpdateNotice),
	projects: arr(Project),
	recentProjects: arr(Project),
	config: AppConfig,
});
export type ServerWelcome = Static<typeof ServerWelcome>;

function bareObject<T>(): Schema<T> {
	return { type: "object" };
}

const HOST_VERSION_FIELDS = {
	protocolVersion: num(),
	protocolMin: opt(num()),
	protocolMax: opt(num()),
};

/** All a client reads from a welcome before it knows the host is in range. */
export const HostWelcomeVersions = wireObj(HOST_VERSION_FIELDS);
export type HostWelcomeVersions = Static<typeof HostWelcomeVersions>;

/** What a client needs from the welcome of a host in range. */
export const AnyHostWelcome = wireObj({
	...HOST_VERSION_FIELDS,
	appVersion: opt(str()),
	hostPlatform: opt(str()),
	hostUpdate: opt(bareObject<HostUpdateNotice>()),
	projects: arr(bareObject<Project>()),
	recentProjects: opt(arr(bareObject<Project>())),
	config: opt(bareObject<AppConfig>()),
});
export type AnyHostWelcome = Static<typeof AnyHostWelcome>;

export const HOST_METHODS = {
	"host.update": { params: NoParams, result: Ack },
};

export const HOST_CHANNELS = {
	"server.welcome": ServerWelcome,
	"host.updateAvailable": HostUpdateNotice,
};
