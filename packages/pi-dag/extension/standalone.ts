import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { type ExtensionFactory, getAgentDir } from "@earendil-works/pi-coding-agent";
import { createDelegationService } from "pi-delegation";
import type { DagService } from "../domain/index.ts";
import { createDagService } from "../runtime/index.ts";
import { installDagAdapter } from "./adapter.ts";

const registryVersion = 1;
interface Registry {
	version: typeof registryVersion;
	owners: Map<string, DagService>;
	closing?: Promise<void>;
}

declare global {
	/** Standalone DAG owners, shared by every pi-dag copy loaded in this process. */
	var piDagStandaloneOwners: unknown;
}

/** Every `DagService` method by name; the literal fails tsc when a method is added or removed. */
const serviceMethods: Record<keyof DagService, true> = { bind: true, close: true };

const isService = (value: unknown) =>
	typeof value === "object" &&
	value !== null &&
	Object.keys(serviceMethods).every((method) => typeof Reflect.get(value, method) === "function");

function isRegistry(value: unknown): value is Registry {
	if (
		typeof value !== "object" ||
		value === null ||
		!("version" in value) ||
		value.version !== registryVersion ||
		!("owners" in value) ||
		!(value.owners instanceof Map) ||
		("closing" in value && !(value.closing instanceof Promise))
	)
		return false;
	const owners: Iterable<[unknown, unknown]> = value.owners;
	return [...owners].every(([key, service]) => typeof key === "string" && isService(service));
}

function registry(): Registry {
	const existing = globalThis.piDagStandaloneOwners;
	if (existing === undefined) {
		const created: Registry = { version: registryVersion, owners: new Map() };
		globalThis.piDagStandaloneOwners = created;
		return created;
	}
	if (!isRegistry(existing))
		throw new Error("Incompatible pi-dag standalone owner registry; restart the process");
	return existing;
}

function canonical(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync(absolute);
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
		if (lstatSync(absolute, { throwIfNoEntry: false })) throw error;
		const parent = dirname(absolute);
		if (parent === absolute) throw error;
		return join(canonical(parent), basename(absolute));
	}
}

function standaloneService(cwd: string): DagService {
	const state = registry();
	if (state.closing) throw new Error("DAG standalone owners are closing");
	const agentRoot = canonical(getAgentDir());
	const workspace = canonical(cwd);
	const key = JSON.stringify([agentRoot, workspace]);
	const existing = state.owners.get(key);
	if (existing) return existing;
	const scope = createHash("sha256").update(workspace).digest("hex");
	const service = createDagService({
		storageRoot: join(agentRoot, "dags"),
		scope,
		delegation: createDelegationService({ delegationRoot: join(agentRoot, "delegation"), scope }),
	});
	state.owners.set(key, service);
	return service;
}

async function closeStandalone(): Promise<void> {
	if (globalThis.piDagStandaloneOwners === undefined) return;
	const state = registry();
	state.closing ??= Promise.resolve().then(async () => {
		const results = await Promise.allSettled(
			[...state.owners.values()].map((owner) => owner.close()),
		);
		const failures = results.filter((result) => result.status === "rejected");
		if (failures.length)
			throw new AggregateError(
				failures.map((result) => result.reason),
				"DAG standalone shutdown failed",
			);
		state.owners.clear();
		globalThis.piDagStandaloneOwners = undefined;
	});
	await state.closing;
}

const standalone: ExtensionFactory = (pi) =>
	installDagAdapter(pi, (ctx) => standaloneService(ctx.cwd), undefined, closeStandalone);

export default standalone;
