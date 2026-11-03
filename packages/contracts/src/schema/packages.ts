import { arr, bool, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import { WorkspaceId } from "./ids";
import { Ack, NoPayload, wireObj } from "./wire";

export const PiPackageScope = oneOf(["user", "project"]);
export type PiPackageScope = Static<typeof PiPackageScope>;

export const PiPackageSourceKind = oneOf(["npm", "git", "local"]);
export type PiPackageSourceKind = Static<typeof PiPackageSourceKind>;

/** The pi resource kinds the Extensions page lists and toggles; themes are terminal-only and never shown. */
export const PiPackageResourceType = oneOf(["extensions", "skills", "prompts"]);
export type PiPackageResourceType = Static<typeof PiPackageResourceType>;

/** One file a pi package contributes, in pi's resolved `enabled` state; `path` is the toggle target. */
export const PiPackageResource = wireObj({
	type: PiPackageResourceType,
	path: str(),
	/** pi's `pi config` display rule: `parent/file.ts` for a nested extension, the folder for a skill, else the file name. */
	displayName: str(),
	enabled: bool(),
	/** Extensions only, when the host could load the file: the tool and command names it registered. */
	tools: opt(arr(str())),
	commands: opt(arr(str())),
	/** Extensions only: pi's load error. */
	error: opt(str()),
});
export type PiPackageResource = Static<typeof PiPackageResource>;

/** One installed pi package as declared in a settings file; every summary is on disk. */
export const PiPackageSummary = wireObj({
	/** Host-wide identity the package switch keys on: npm by name, git by repo without ref, local by resolved path. */
	identity: str(),
	/** The source string exactly as declared (`npm:@scope/pkg@1.2.0`, `git:host/owner/repo@ref`, a path). */
	source: str(),
	kind: PiPackageSourceKind,
	scope: PiPackageScope,
	name: str(),
	version: opt(str()),
	description: opt(str()),
	/** Absent when the declaration has no install on disk: pi retries at a chat's next start; the row offers Remove only. */
	installedPath: opt(str()),
	/** Every `disabledPackages` key that switches this package off: its own `identity` and those of pi-equivalent declarations. */
	switchKeys: arr(str()),
	/** The host-wide switch, closed over pi's equivalence: `false` when any of `switchKeys` is in `disabledPackages`. */
	enabled: bool(),
	/** `true` for a user declaration pi leaves aside because the repository declares the same identity. */
	shadowed: opt(bool()),
	resources: arr(PiPackageResource),
});
export type PiPackageSummary = Static<typeof PiPackageSummary>;

/** An extension pi discovers outside any package: a file under `<agentDir>/extensions`, `.pi/extensions`, or an explicit `extensions[]` settings path. */
export const PiLooseExtension = wireObj({
	path: str(),
	displayName: str(),
	scope: PiPackageScope,
	/** `true` for an `extensions[]` settings entry, `false` for an auto-discovered directory file. */
	explicit: bool(),
	enabled: bool(),
	tools: opt(arr(str())),
	commands: opt(arr(str())),
	error: opt(str()),
});
export type PiLooseExtension = Static<typeof PiLooseExtension>;

/** One of pi's built-in extensions the host runs (`mcp`, `tool-search`), toggled through `±builtin:<name>` in pi settings. */
export const PiBuiltinExtension = wireObj({
	name: str(),
	enabled: bool(),
	/** `project` when a `.pi/settings.json` entry decides it, else `user`. */
	scope: PiPackageScope,
});
export type PiBuiltinExtension = Static<typeof PiBuiltinExtension>;

export const PiPackagesCatalog = wireObj({
	/** The effective pi folder; every path shown derives from it, never from a hardcoded `~/.pi/agent`. */
	agentDir: str(),
	settingsPath: str(),
	/** Present when the catalog was read for a workspace. */
	projectSettingsPath: opt(str()),
	/** pi-level trust of that workspace's project; repository packages are read only when `true`. */
	projectTrusted: bool(),
	packages: arr(PiPackageSummary),
	loose: arr(PiLooseExtension),
	builtins: arr(PiBuiltinExtension),
});
export type PiPackagesCatalog = Static<typeof PiPackagesCatalog>;

const PackageSource = wireObj({ source: str(), scope: PiPackageScope });

export const PACKAGES_METHODS = {
	"packages.list": {
		params: wireObj({ workspaceId: opt(WorkspaceId) }),
		result: PiPackagesCatalog,
	},
	"packages.install": {
		params: wireObj({ source: str(), scope: PiPackageScope, workspaceId: opt(WorkspaceId) }),
		result: PiPackageSummary,
	},
	"packages.remove": {
		params: wireObj({ source: str(), scope: PiPackageScope, workspaceId: opt(WorkspaceId) }),
		result: Ack,
	},
	"packages.update": {
		params: wireObj({ packages: arr(PackageSource), workspaceId: opt(WorkspaceId) }),
		result: Ack,
	},
	"packages.checkUpdates": {
		params: wireObj({ workspaceId: opt(WorkspaceId), force: opt(bool()) }),
		result: arr(PackageSource),
	},
	"packages.setResourceEnabled": {
		params: wireObj({
			path: str(),
			type: PiPackageResourceType,
			scope: PiPackageScope,
			enabled: bool(),
			workspaceId: opt(WorkspaceId),
		}),
		result: Ack,
	},
	"packages.reveal": {
		params: wireObj({ path: str(), workspaceId: opt(WorkspaceId) }),
		result: Ack,
	},
};

export const PACKAGES_CHANNELS = {
	"packages.changed": NoPayload,
};
