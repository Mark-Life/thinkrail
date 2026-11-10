import { describe, expect, test } from "bun:test";
import { parseWelcome } from "./welcome";

const project = { id: "p1", name: "one", path: "/one", slug: "one", lastOpened: 1 };

describe("parseWelcome", () => {
	test("keeps what an older host sends that still reads, and names what it leaves out", () => {
		const welcome = parseWelcome({
			protocolVersion: 1,
			hostPlatform: "plan9",
			projects: [project, { id: "", name: "broken" }],
			config: { analyticsEnabled: "yes", chatLineWidth: 100, themeMode: "system" },
			speech: { status: "unknown" },
		});

		expect(welcome.projects).toEqual([project]);
		expect(welcome.recentProjects).toEqual([project]);
		expect(welcome.config).toEqual({ chatLineWidth: 100, themeMode: "system" });
		expect(welcome.hostPlatform).toBeUndefined();
		expect(welcome.speech).toBeUndefined();
		expect(welcome.dropped).toEqual([
			"projects",
			"hostPlatform",
			"config.analyticsEnabled",
			"speech",
		]);
	});

	test("a current welcome loses nothing", () => {
		const welcome = parseWelcome({
			protocolVersion: 1,
			hostPlatform: "darwin",
			projects: [project],
			recentProjects: [],
			config: { onboardingDismissed: true },
		});

		expect(welcome.hostPlatform).toBe("darwin");
		expect(welcome.recentProjects).toEqual([]);
		expect(welcome.config).toEqual({ onboardingDismissed: true });
		expect(welcome.dropped).toEqual([]);
	});
});
