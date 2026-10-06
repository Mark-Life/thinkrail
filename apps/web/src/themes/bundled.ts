import { buildThemeCatalog, installThemeCatalog } from "./runtime";

let initialized = false;

export function initializeBundledThemes(): void {
	if (initialized) return;

	const bundled = import.meta.glob("./bundled/*.theme.json", {
		eager: true,
		import: "default",
	});

	installThemeCatalog(buildThemeCatalog(bundled));
	initialized = true;
}
