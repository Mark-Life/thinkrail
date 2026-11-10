export interface DesktopHostOptions {
	runtimeDir: string;
	staticDir: string;
	appVersion: string;
	channel: string;
	posthogProjectKey: string;
	openExternal?: (url: string) => void;
}

export interface DesktopHost {
	server: {
		readonly port: number;
		startAttributionClaim(): void;
		stop(): void;
		shutdown(): Promise<void>;
	};
	port: number;
	requested: number;
	reportError(error: unknown, scope: string): void;
}

export interface DesktopServerRuntime {
	startDesktopHost(options: DesktopHostOptions): Promise<DesktopHost>;
}

/** The runtime module loads from a computed path, so its exports reach the desktop untyped. */
export function isDesktopServerRuntime(value: unknown): value is DesktopServerRuntime {
	return (
		typeof value === "object" &&
		value !== null &&
		"startDesktopHost" in value &&
		typeof value.startDesktopHost === "function"
	);
}
