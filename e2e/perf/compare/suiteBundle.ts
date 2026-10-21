import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, gzip } from "node:zlib";
import { MANIFEST_DIST, manifestWeb } from "./artifacts";
import { chunkIds, hashMask, initialFiles, type Manifest } from "./bundleManifest";
import type { Measurement, Suite } from "./types";

const ENCODINGS = ["raw", "gzip", "brotli"] as const;
type Encoding = (typeof ENCODINGS)[number];
type Sizes = Record<Encoding, number>;

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);
const ZERO: Sizes = { raw: 0, gzip: 0, brotli: 0 };
const CODE = /\.(js|css)$/;

async function fileSizes(path: string, mask: (text: string) => string): Promise<Sizes> {
	const content = readFileSync(path);
	const bytes = CODE.test(path) ? Buffer.from(mask(content.toString("utf8"))) : content;
	return {
		raw: content.byteLength,
		gzip: (await gzipAsync(bytes, { level: 9 })).byteLength,
		brotli: (await brotliAsync(bytes)).byteLength,
	};
}

function sum(sizes: readonly Sizes[]): Sizes {
	return sizes.reduce(
		(total, size) => ({
			raw: total.raw + size.raw,
			gzip: total.gzip + size.gzip,
			brotli: total.brotli + size.brotli,
		}),
		ZERO,
	);
}

function exact(input: Pick<Measurement, "id" | "group" | "label" | "value" | "unit">): Measurement {
	return { ...input, kind: "exact", better: "lower" };
}

function sizeRows(input: { id: string; group: string; label: string; sizes: Sizes }) {
	return ENCODINGS.map((encoding) =>
		exact({
			id: `${input.id}/${encoding}`,
			group: input.group,
			label: `${input.label} (${encoding})`,
			value: input.sizes[encoding],
			unit: "bytes",
		}),
	);
}

function distBytes(dir: string): number {
	return readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
		if (entry.name === ".vite") return total;
		const path = join(dir, entry.name);
		return total + (entry.isDirectory() ? distBytes(path) : statSync(path).size);
	}, 0);
}

function readManifest(distDir: string): Manifest {
	const path = join(distDir, ".vite", "manifest.json");
	if (!existsSync(path)) throw new Error(`no Vite manifest at ${path}`);
	return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

export async function measureBundle(distDir: string): Promise<Measurement[]> {
	const manifest = readManifest(distDir);
	const ids = chunkIds(manifest);
	const files = new Set(
		Object.values(manifest).flatMap((chunk) => [
			chunk.file,
			...(chunk.css ?? []),
			...(chunk.assets ?? []),
		]),
	);
	const mask = hashMask(files);
	const sizes = new Map(
		await Promise.all(
			[...files].map(async (file) => [file, await fileSizes(join(distDir, file), mask)] as const),
		),
	);
	const sizeOf = (list: readonly string[]) => sum(list.map((file) => sizes.get(file) ?? ZERO));
	const byType = new Map<string, string[]>();
	for (const file of files) {
		const type = extname(file).slice(1) || "other";
		byType.set(type, [...(byType.get(type) ?? []), file]);
	}
	const initial = initialFiles(manifest);
	const entries = [...ids].sort(([, a], [, b]) => a.localeCompare(b));
	const rows = entries.flatMap(([key, id]) => {
		const chunk = manifest[key];
		if (!chunk) return [];
		const own = CODE.test(chunk.file)
			? sizeRows({
					id: `bundle/chunk/${id}`,
					group: "chunks",
					label: id,
					sizes: sizeOf([chunk.file]),
				})
			: [
					exact({
						id: `bundle/asset/${id}`,
						group: "assets",
						label: id,
						value: sizeOf([chunk.file]).raw,
						unit: "bytes",
					}),
				];
		const css = chunk.css?.length
			? sizeRows({
					id: `bundle/css/${id}`,
					group: "css",
					label: `${id} css`,
					sizes: sizeOf(chunk.css),
				})
			: [];
		return [...own, ...css];
	});
	const totals = [...byType]
		.sort(([a], [b]) => a.localeCompare(b))
		.flatMap(([type, list]) =>
			sizeRows({
				id: `bundle/total/${type}`,
				group: "totals",
				label: `total ${type}`,
				sizes: sizeOf(list),
			}),
		);
	const count = (id: string, label: string, value: number) =>
		exact({ id, group: "totals", label, value, unit: "count" });
	return [
		...sizeRows({
			id: "bundle/initial-js",
			group: "totals",
			label: "initial JS",
			sizes: sizeOf(initial.js),
		}),
		...sizeRows({
			id: "bundle/initial-css",
			group: "totals",
			label: "initial CSS",
			sizes: sizeOf(initial.css),
		}),
		...totals,
		exact({
			id: "bundle/dist",
			group: "totals",
			label: "dist on disk",
			value: distBytes(distDir),
			unit: "bytes",
		}),
		count("bundle/files", "files", files.size),
		count("bundle/js-chunks", "JS chunks", byType.get("js")?.length ?? 0),
		...rows,
	];
}

export const bundleSuite: Suite<"bundle"> = {
	name: "bundle",
	artifacts: [manifestWeb],
	browser: false,
	schedule: () => ({ kind: "once" }),
	variants: () => ["web"],
	async sample(context) {
		return { ok: true, measurements: await measureBundle(join(context.appRoot, MANIFEST_DIST)) };
	},
};
