import type { desktopHostStarter } from "../runtimeEntry";

export interface DesktopServerRuntime {
	startDesktopHost: ReturnType<typeof desktopHostStarter>;
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
