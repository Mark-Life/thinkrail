import { compile } from "@earendil-works/pi-schema";
import {
	type AnyHostWelcome,
	HostPlatform,
	HostUpdateNotice,
	PartialAppConfig,
	Project,
	SpeechStatus,
} from "@thinkrail/contracts";

const project = compile(Project);
const hostPlatform = compile(HostPlatform);
const hostUpdate = compile(HostUpdateNotice);
const speechStatus = compile(SpeechStatus);
const partialConfig = compile(PartialAppConfig);

function topField(pointer: string): string {
	const [, first = ""] = pointer.split("/");
	return first.replaceAll("~1", "/").replaceAll("~0", "~");
}

function configOf(raw: Record<string, unknown>, dropped: string[]): PartialAppConfig | undefined {
	let kept = raw;
	while (!partialConfig.check(kept)) {
		const refused = new Set(partialConfig.errors(kept).map((error) => topField(error.path)));
		refused.delete("");
		if (refused.size === 0) {
			dropped.push("config");
			return undefined;
		}
		for (const field of refused) dropped.push(`config.${field}`);
		kept = Object.fromEntries(Object.entries(kept).filter(([field]) => !refused.has(field)));
	}
	return kept;
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
		projects,
		recentProjects: welcome.recentProjects
			? projectsOf(welcome.recentProjects, "recentProjects", dropped)
			: projects,
		config: welcome.config ? configOf(welcome.config, dropped) : undefined,
		speech: entryOf(welcome.speech, speechStatus.check, "speech", dropped),
		dropped,
	};
}
