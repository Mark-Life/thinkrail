import type { Artifact } from "./types";

export const MANIFEST_DIST = "apps/web/perf-manifest/dist";

export const profileWeb: Artifact = {
	key: "profile-web",
	cwd: "apps/web",
	command: ["build:profile"],
};

export const manifestWeb: Artifact = {
	key: "manifest-web",
	cwd: "apps/web",
	command: ["vite", "build", "--manifest", "--outDir", "perf-manifest/dist", "--emptyOutDir"],
};

export const binary: Artifact = {
	key: "binary",
	cwd: ".",
	command: ["build:binary"],
};

export const desktop: Artifact = {
	key: "desktop",
	cwd: ".",
	command: ["desktop:build"],
	platforms: ["darwin"],
};
