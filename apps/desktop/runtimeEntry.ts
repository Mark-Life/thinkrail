import {
	type BundledExtensions,
	bootHost,
	registerBundledRuntime,
	reportDesktopError,
} from "@thinkrail/server";

export interface DesktopHostOptions {
	runtimeDir: string;
	staticDir: string;
	appVersion: string;
	channel: string;
	posthogProjectKey: string;
	openExternal?: (url: string) => void;
}

/** `startDesktopHost` of the server-runtime bundle, over the pi-package factories `preBuild.ts` bundles. */
export function desktopHostStarter(factories: BundledExtensions["factories"]) {
	return async (options: DesktopHostOptions) => {
		await registerBundledRuntime({
			factories,
			skillsDir: `${options.runtimeDir}/skills`,
			trashHelpers: {
				macos: `${options.runtimeDir}/macos-trash`,
				windows: `${options.runtimeDir}/windows-trash.exe`,
			},
		});
		const host = await bootHost({
			port: 0,
			host: "127.0.0.1",
			portMode: "exact",
			resolveShellEnv: true,
			staticDir: options.staticDir,
			appVersion: options.appVersion,
			analytics: {
				posthogApiKey: options.posthogProjectKey,
				channel: options.channel,
				build: "desktop",
				appRoot: `${options.runtimeDir}/..`,
				...(options.openExternal ? { openExternal: options.openExternal } : {}),
			},
		});
		return { ...host, reportError: reportDesktopError };
	};
}
