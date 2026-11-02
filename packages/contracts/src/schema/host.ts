import { arr, num, oneOf, opt, type Schema, type Static, str } from "@earendil-works/pi-schema";
import { Project } from "./project";
import { AppConfig } from "./settings";
import { Ack, NoParams, wireObj } from "./wire";

export const HostPlatform = oneOf(["darwin", "linux", "win32"]);
export type HostPlatform = Static<typeof HostPlatform>;

export const HostUpdateStatus = oneOf(["available", "running", "succeeded", "failed"]);
export type HostUpdateStatus = Static<typeof HostUpdateStatus>;

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
	projects: arr(Project),
	recentProjects: arr(Project),
	config: AppConfig,
});
export type ServerWelcome = Static<typeof ServerWelcome>;

function bareObject<T>(): Schema<T> {
	return { type: "object" };
}

/** What a client needs from a welcome of any host version. Older hosts omit later fields and send older shapes. */
export const AnyHostWelcome = wireObj({
	protocolVersion: num(),
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
