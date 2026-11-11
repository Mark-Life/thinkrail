import { compile } from "@earendil-works/pi-schema";
import {
	type AnyHostWelcome,
	HostPlatform,
	HostUpdateNotice,
	type PartialAppConfig,
	Project,
	parseAppConfigFields,
	SpeechStatus,
} from "@thinkrail/contracts";

const project = compile(Project);
const hostPlatform = compile(HostPlatform);
const hostUpdate = compile(HostUpdateNotice);
const speechStatus = compile(SpeechStatus);

function configOf(raw: Record<string, unknown>, dropped: string[]): PartialAppConfig | undefined {
	const parsed = parseAppConfigFields(raw);
	if (parsed === null) {
		dropped.push("config");
		return undefined;
	}
	for (const field of parsed.dropped) dropped.push(`config.${field}`);
	return parsed.fields;
}

function projectsOf(raw: Record<string, unknown>[], field: string, dropped: string[]): Project[] {
	const kept = raw.filter(project.check);
	if (kept.length < raw.length) dropped.push(field);
	return kept;
}

function entryOf<T>(
	raw: unknown,
	check: (value: unknown) => value is T,
	field: string,
	dropped: string[],
): T | undefined {
	if (raw === undefined) return undefined;
	if (check(raw)) return raw;
	dropped.push(field);
	return undefined;
}

export function parseWelcome(welcome: AnyHostWelcome) {
	const dropped: string[] = [];
	const projects = projectsOf(welcome.projects, "projects", dropped);
	return {
		protocolVersion: welcome.protocolVersion,
		appVersion: welcome.appVersion,
		hostPlatform: entryOf(welcome.hostPlatform, hostPlatform.check, "hostPlatform", dropped),
		hostUpdate: entryOf(welcome.hostUpdate, hostUpdate.check, "hostUpdate", dropped),
		configReadFailed: welcome.configReadFailed === true,
		projects,
		recentProjects: welcome.recentProjects
			? projectsOf(welcome.recentProjects, "recentProjects", dropped)
			: projects,
		config: welcome.config ? configOf(welcome.config, dropped) : undefined,
		speech: entryOf(welcome.speech, speechStatus.check, "speech", dropped),
		dropped,
	};
}
