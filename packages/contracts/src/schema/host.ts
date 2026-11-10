import { arr, map, num, oneOf, opt, type Static, str, unknown } from "@earendil-works/pi-schema";
import { Project } from "./project";
import { AppConfig } from "./settings";
import { SpeechStatus } from "./speech";
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
	appVersion: opt(str()),
	hostPlatform: opt(HostPlatform),
	hostUpdate: opt(HostUpdateNotice),
	projects: arr(Project),
	recentProjects: arr(Project),
	config: AppConfig,
	/** Voice input state, from `SPEECH_PROTOCOL_VERSION`; later changes arrive on `speech.changed`. */
	speech: opt(SpeechStatus),
});
export type ServerWelcome = Static<typeof ServerWelcome>;

const AnyObject = map(unknown());

/** What a client needs from a welcome of any host version; the client parses each entry against its own schema. */
export const AnyHostWelcome = wireObj({
	protocolVersion: num(),
	appVersion: opt(str()),
	hostPlatform: opt(str()),
	hostUpdate: opt(AnyObject),
	projects: arr(AnyObject),
	recentProjects: opt(arr(AnyObject)),
	config: opt(AnyObject),
	speech: opt(AnyObject),
});
export type AnyHostWelcome = Static<typeof AnyHostWelcome>;

export const HOST_METHODS = {
	"host.update": { params: NoParams, result: Ack },
};

export const HOST_CHANNELS = {
	"server.welcome": ServerWelcome,
	"host.updateAvailable": HostUpdateNotice,
};
