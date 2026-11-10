import {
	arr,
	bool,
	lit,
	num,
	oneOf,
	opt,
	type Static,
	str,
	union,
} from "@earendil-works/pi-schema";
import { NoParams, wireObj } from "./wire";

export const HostEnvironmentVar = wireObj({ name: str(), value: str() });
export type HostEnvironmentVar = Static<typeof HostEnvironmentVar>;

export const HostEnvironment = wireObj({ agentDir: opt(str()), vars: arr(HostEnvironmentVar) });
export type HostEnvironment = Static<typeof HostEnvironment>;

export const HostEnvironmentIssue = union([
	wireObj({ field: lit("agentDir"), code: oneOf(["notAbsolute", "notFound", "notDirectory"]) }),
	wireObj({
		field: lit("var"),
		index: num(),
		code: oneOf(["invalidName", "reserved", "duplicate"]),
	}),
]);
export type HostEnvironmentIssue = Static<typeof HostEnvironmentIssue>;

export const HostEnvironmentStatus = wireObj({
	stored: HostEnvironment,
	restartRequired: bool(),
	launchOverridden: arr(str()),
	effectiveAgentDir: str(),
});
export type HostEnvironmentStatus = Static<typeof HostEnvironmentStatus>;

export const HostEnvironmentUpdateResult = union([
	wireObj({ ok: lit(true), status: HostEnvironmentStatus }),
	wireObj({ ok: lit(false), issues: arr(HostEnvironmentIssue) }),
]);
export type HostEnvironmentUpdateResult = Static<typeof HostEnvironmentUpdateResult>;

export const ENVIRONMENT_METHODS = {
	"environment.get": { params: NoParams, result: HostEnvironmentStatus },
	"environment.update": {
		params: wireObj({ environment: HostEnvironment }),
		result: HostEnvironmentUpdateResult,
	},
};
