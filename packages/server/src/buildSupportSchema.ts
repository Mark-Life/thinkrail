import { arr, obj, type Static, str } from "@earendil-works/pi-schema";

export const DESKTOP_RUNTIME_TARGETS = [
	"darwin-arm64",
	"darwin-x64",
	"linux-arm64",
	"linux-x64",
	"win32-x64",
] as const;
export type DesktopRuntimeTarget = (typeof DESKTOP_RUNTIME_TARGETS)[number];

/** The build-support manifest. It loads only pi-schema, so a build hook may check the manifest it reads. */
export const BuildRuntimeSources = obj({
	extensions: arr(obj({ specifier: str(), entry: str() })),
	skillRoots: arr(obj({ source: str(), route: str() })),
	ptyLibraries: obj({
		"darwin-arm64": str(),
		"darwin-x64": str(),
		"linux-arm64": str(),
		"linux-x64": str(),
		"win32-x64": str(),
	} satisfies Record<DesktopRuntimeTarget, unknown>),
	trashHelpers: obj({ macos: str(), windows: str() }),
});
export type BuildRuntimeSources = Static<typeof BuildRuntimeSources>;
