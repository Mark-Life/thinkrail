import { join } from "node:path";
import { runBun } from "./checkout";
import type { Artifact } from "./types";

export const MANIFEST_DIST = "apps/web/dist-manifest";

export const profileWeb: Artifact = {
	key: "profile-web",
	inputs: ["build:profile"],
	async build(appRoot, env) {
		await runBun(
			["run", "--cwd", join(appRoot, "apps/web"), "build:profile"],
			"profile web build",
			env,
		);
	},
};

export const manifestWeb: Artifact = {
	key: "manifest-web",
	inputs: ["vite build --manifest --outDir dist-manifest"],
	async build(appRoot, env) {
		await runBun(
			[
				"run",
				"--cwd",
				join(appRoot, "apps/web"),
				"vite",
				"build",
				"--manifest",
				"--outDir",
				"dist-manifest",
				"--emptyOutDir",
			],
			"manifest web build",
			env,
		);
	},
};

export const binary: Artifact = {
	key: "binary",
	inputs: ["build:binary"],
	async build(appRoot, env) {
		await runBun(["run", "--cwd", appRoot, "build:binary"], "binary build", env);
	},
};

export const desktop: Artifact = {
	key: "desktop",
	inputs: ["desktop:build"],
	platforms: ["darwin"],
	async build(appRoot, env) {
		await runBun(["run", "--cwd", appRoot, "desktop:build"], "desktop build", env);
	},
};
