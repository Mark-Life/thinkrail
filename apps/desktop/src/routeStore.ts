import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { compile, lit, map, obj, str, unknown } from "@earendil-works/pi-schema";

const ROUTE_VERSION = 1;
const FALLBACK_ROUTE = "#/v1";
const MAX_ROUTE_LENGTH = 4096;

interface RouteDocument {
	version: 1;
	routes: Record<string, string>;
}

const Route = compile(str({ pattern: "^#[^\\x00-\\x1f\\x7f]*$", maxLength: MAX_ROUTE_LENGTH }));
const RouteFile = compile(
	obj({ version: lit(ROUTE_VERSION), routes: map(unknown()) }, { open: true }),
);

function readDocument(path: string): RouteDocument {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!RouteFile.check(value)) return { version: ROUTE_VERSION, routes: {} };
		const routes: Record<string, string> = {};
		for (const [key, route] of Object.entries(value.routes)) {
			if (Route.check(route)) routes[key] = route;
		}
		return { version: ROUTE_VERSION, routes };
	} catch {
		return { version: ROUTE_VERSION, routes: {} };
	}
}

export class RouteStore {
	readonly #path: string;
	readonly #document: RouteDocument;

	constructor(path: string) {
		this.#path = path;
		this.#document = existsSync(path) ? readDocument(path) : { version: ROUTE_VERSION, routes: {} };
	}

	read(backendProfileId: string, windowId: string): string {
		return this.#document.routes[`${backendProfileId}:${windowId}`] ?? FALLBACK_ROUTE;
	}

	write(backendProfileId: string, windowId: string, route: string): boolean {
		if (!Route.check(route)) return false;
		const key = `${backendProfileId}:${windowId}`;
		if (this.#document.routes[key] === route) return true;
		this.#document.routes[key] = route;
		mkdirSync(dirname(this.#path), { recursive: true });
		writeFileSync(this.#path, `${JSON.stringify(this.#document, null, "\t")}\n`);
		return true;
	}
}
