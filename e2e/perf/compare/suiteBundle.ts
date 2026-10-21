import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { MANIFEST_DIST, manifestWeb } from "./artifacts";
import type { Measurement, Suite } from "./types";

interface ManifestChunk {
	file: string;
	isEntry?: boolean;
	imports?: string[];
	css?: string[];
	assets?: string[];
}

type Manifest = Record<string, ManifestChunk>;

const ENCODINGS = ["raw", "gzip", "brotli"] as const;
type Encoding = (typeof ENCODINGS)[number];
type Sizes = Record<Encoding, number>;

function fileSizes(path: string): Sizes {
	const bytes = readFileSync(path);
	return {
		raw: bytes.byteLength,
		gzip: gzipSync(bytes, { level: 9 }).byteLength,
		brotli: brotliCompressSync(bytes).byteLength,
	};
}

function add(a: Sizes, b: Sizes): Sizes {
	return { raw: a.raw + b.raw, gzip: a.gzip + b.gzip, brotli: a.brotli + b.brotli };
}

const ZERO: Sizes = { raw: 0, gzip: 0, brotli: 0 };

function bytes(input: { id: string; group: string; label: string; value: number }): Measurement {
	return { ...input, unit: "bytes", kind: "exact", better: "lower" };
}

function sizeRows(id: string, group: string, label: string, sizes: Sizes) {
	return ENCODINGS.map((encoding) =>
		bytes({
			id: `${id}/${encoding}`,
			group,
			label: `${label} (${encoding})`,
			value: sizes[encoding],
		}),
	);
}

export function initialJsFiles(manifest: Manifest) {
	const seen = new Set<string>();
	const visit = (key: string) => {
		if (seen.has(key)) return;
		seen.add(key);
		for (const next of manifest[key]?.imports ?? []) visit(next);
	};
	for (const [key, chunk] of Object.entries(manifest)) if (chunk.isEntry) visit(key);
	return [...seen].flatMap((key) => {
		const file = manifest[key]?.file;
		return file?.endsWith(".js") ? [file] : [];
	});
}

export function measureBundle(distDir: string): Measurement[] {
	const manifestPath = join(distDir, ".vite", "manifest.json");
	if (!existsSync(manifestPath)) throw new Error(`no Vite manifest at ${manifestPath}`);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
	const files = new Set(
		Object.values(manifest).flatMap((chunk) => [
			chunk.file,
			...(chunk.css ?? []),
			...(chunk.assets ?? []),
		]),
	);
	const sizes = new Map([...files].map((file) => [file, fileSizes(join(distDir, file))]));
	const byType = new Map<string, Sizes>();
	for (const [file, size] of sizes) {
		const type = extname(file).slice(1) || "other";
		byType.set(type, add(byType.get(type) ?? ZERO, size));
	}
	const initial = initialJsFiles(manifest).reduce(
		(total, file) => add(total, sizes.get(file) ?? ZERO),
		ZERO,
	);
	const chunks = Object.entries(manifest)
		.filter(([, chunk]) => chunk.file.endsWith(".js") || chunk.file.endsWith(".css"))
		.sort(([a], [b]) => a.localeCompare(b))
		.flatMap(([key, chunk]) =>
			sizeRows(`bundle/chunk/${key}`, "chunks", key, sizes.get(chunk.file) ?? ZERO),
		);
	const totals = [...byType]
		.sort(([a], [b]) => a.localeCompare(b))
		.flatMap(([type, size]) => sizeRows(`bundle/total/${type}`, "totals", `total ${type}`, size));
	return [
		...sizeRows("bundle/initial-js", "totals", "initial JS", initial),
		...totals,
		{
			...bytes({ id: "bundle/files", group: "totals", label: "files", value: files.size }),
			unit: "count",
		},
		...chunks,
	];
}

export const bundleSuite: Suite<"bundle"> = {
	name: "bundle",
	artifacts: [manifestWeb],
	browser: false,
	schedule: () => ({ kind: "once" }),
	variants: () => ["web"],
	async sample(context) {
		return { ok: true, measurements: measureBundle(join(context.appRoot, MANIFEST_DIST)) };
	},
};
