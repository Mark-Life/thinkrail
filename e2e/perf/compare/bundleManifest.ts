export interface ManifestChunk {
	file: string;
	src?: string;
	name?: string;
	isEntry?: boolean;
	isDynamicEntry?: boolean;
	imports?: string[];
	dynamicImports?: string[];
	css?: string[];
	assets?: string[];
}

export type Manifest = Record<string, ManifestChunk>;

const BUN_STORE = /^node_modules\/\.bun\/([^/]+)\/node_modules\/(.+)$/;
const CONTENT_HASH = /-[\w-]{8}(?=\.\w+$)/;

function sourcePath(key: string) {
	const path = key.replace(/^(\.\.\/)+/, "");
	const store = BUN_STORE.exec(path);
	if (!store?.[1] || !store[2]) return { name: path, version: null };
	const dir = store[1];
	return { name: `node_modules/${store[2]}`, version: dir.slice(dir.lastIndexOf("@") + 1) };
}

function baseName(key: string) {
	return key.startsWith("_") ? key.replace(CONTENT_HASH, "") : sourcePath(key).name;
}

function importersOf(manifest: Manifest) {
	const importers = new Map<string, string[]>();
	for (const [key, chunk] of Object.entries(manifest)) {
		for (const target of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) {
			importers.set(target, [...(importers.get(target) ?? []), key]);
		}
	}
	return importers;
}

function refine(
	names: Map<string, string>,
	suffix: (key: string, group: readonly string[]) => string,
) {
	const groups = new Map<string, string[]>();
	for (const [key, name] of names) groups.set(name, [...(groups.get(name) ?? []), key]);
	for (const [name, keys] of groups) {
		if (keys.length < 2) continue;
		for (const key of keys) names.set(key, `${name}${suffix(key, keys)}`);
	}
}

export function chunkIds(manifest: Manifest) {
	const keys = Object.keys(manifest).sort();
	const plain = new Map(keys.map((key) => [key, baseName(key)]));
	const names = new Map(plain);
	const importers = importersOf(manifest);
	refine(names, (key) => {
		const version = key.startsWith("_") ? null : sourcePath(key).version;
		return version ? ` (v${version})` : "";
	});
	refine(names, (key) => {
		const from = (importers.get(key) ?? []).map((importer) => plain.get(importer) ?? importer);
		const first = from.sort()[0];
		return first ? ` (from ${first})` : "";
	});
	refine(names, (key, group) => {
		const files = group.map((member) => manifest[member]?.file ?? member).sort();
		return ` #${files.indexOf(manifest[key]?.file ?? key) + 1}`;
	});
	return names;
}

export function initialKeys(manifest: Manifest) {
	const seen = new Set<string>();
	const visit = (key: string) => {
		if (seen.has(key)) return;
		seen.add(key);
		for (const next of manifest[key]?.imports ?? []) visit(next);
	};
	for (const [key, chunk] of Object.entries(manifest)) if (chunk.isEntry) visit(key);
	return [...seen];
}

export function initialFiles(manifest: Manifest) {
	const chunks = initialKeys(manifest).flatMap((key) => {
		const chunk = manifest[key];
		return chunk ? [chunk] : [];
	});
	return {
		js: [...new Set(chunks.map((chunk) => chunk.file).filter((file) => file.endsWith(".js")))],
		css: [...new Set(chunks.flatMap((chunk) => chunk.css ?? []))],
	};
}

export function hashMask(files: Iterable<string>) {
	const hashes = new Set<string>();
	for (const file of files) {
		const hash = /-([\w-]{8})\.\w+$/.exec(file)?.[1];
		if (hash) hashes.add(hash);
	}
	if (hashes.size === 0) return (text: string) => text;
	const pattern = new RegExp([...hashes].join("|"), "g");
	return (text: string) => text.replace(pattern, "________");
}
