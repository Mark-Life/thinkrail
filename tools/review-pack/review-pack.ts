#!/usr/bin/env bun
// Review pack for one branch of a stacked PR series. Usage:
//   bun tools/review-pack/review-pack.ts <branch|PR-number> [--base <ref>] [--repo <owner/name>] [--md]
import { spawnSync } from "node:child_process";

const run = (cmd: string, args: string[], cwd?: string) => {
	const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
	if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed:\n${r.stderr}`);
	return r.stdout;
};
const root = run("git", ["rev-parse", "--show-toplevel"]).trim();
const git = (...args: string[]) => run("git", args, root);
const showAt = (ref: string, path: string) => {
	const r = spawnSync("git", ["show", `${ref}:${path}`], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	return r.status === 0 ? r.stdout.split("\n") : [];
};

// ---------- args ----------
const argv = process.argv.slice(2);
const flag = (name: string) => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
};
const md = argv.includes("--md");
const REPO = flag("--repo") ?? "Mark-Life/thinkrail";
const valueFlags = new Set(["--base", "--repo"]);
const target = argv.find((a, i) => !a.startsWith("--") && !valueFlags.has(argv[i - 1] ?? ""));
if (!target) {
	console.error(
		"usage: bun tools/review-pack/review-pack.ts <branch|PR-number> [--base <ref>] [--repo <owner/name>] [--md]",
	);
	process.exit(1);
}
const pr = /^\d+$/.test(target)
	? (JSON.parse(
			run("gh", ["pr", "view", target, "--repo", REPO, "--json", "headRefName,baseRefName"]),
		) as { headRefName: string; baseRefName: string })
	: undefined;
const refExists = (ref: string) =>
	spawnSync("git", ["rev-parse", "--verify", "-q", ref], { cwd: root }).status === 0;
const pickRef = (name: string) => (refExists(name) ? name : `origin/${name}`);
const head = pickRef(pr?.headRefName ?? target);
const base = flag("--base") ?? pickRef(pr?.baseRefName ?? "main");
const mergeBase = git("merge-base", base, head).trim();
const range = `${base}...${head}`;

// ---------- diff model ----------
type Role = "production" | "tests" | "specs+docs" | "generated" | "config";
interface FileStat {
	path: string;
	add: number;
	del: number;
	role: Role;
}
interface Line {
	sign: "+" | "-";
	text: string;
	line: number; // head line for "+", base line for "-"
}

const roleOf = (p: string): Role => {
	if (p === "bun.lock" || /(^|\/)generated\//.test(p) || /\.snap$/.test(p)) return "generated";
	if (/\.test\.tsx?$/.test(p) || p.startsWith("e2e/")) return "tests";
	if (p.endsWith(".md")) return "specs+docs";
	if (
		/(^|\/)(package\.json|tsconfig[^/]*\.json|biome\.jsonc?|turbo\.json|\.gitignore)$/.test(p) ||
		/\.config\.[mc]?[jt]s$/.test(p)
	)
		return "config";
	return "production";
};

const stats: FileStat[] = git("diff", "--numstat", "--no-renames", range)
	.trim()
	.split("\n")
	.filter(Boolean)
	.map((l) => {
		const [a, d, path] = l.split("\t");
		return {
			path,
			add: a === "-" ? 0 : Number(a),
			del: d === "-" ? 0 : Number(d),
			role: roleOf(path),
		};
	});

const parseDiff = (raw: string) => {
	const files = new Map<string, Line[]>();
	let cur: Line[] = [];
	let oldN = 0;
	let newN = 0;
	for (const l of raw.split("\n")) {
		if (l.startsWith("diff --git ")) {
			cur = [];
			files.set(l.replace(/^diff --git a\/.* b\//, ""), cur);
		} else if (l.startsWith("@@")) {
			const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l);
			if (m) [oldN, newN] = [Number(m[1]), Number(m[2])];
		} else if (l.startsWith("+++") || l.startsWith("---")) {
		} else if (l.startsWith("+")) cur.push({ sign: "+", text: l.slice(1), line: newN++ });
		else if (l.startsWith("-")) cur.push({ sign: "-", text: l.slice(1), line: oldN++ });
	}
	return files;
};
const diffs = parseDiff(git("diff", "-U0", "--no-renames", "--no-color", range));
const linesOf = (p: string) => diffs.get(p) ?? [];

// Drops +/- pairs whose trimmed text matches (moved or re-indented lines).
const netLines = (lines: Line[]) => {
	const removed = new Map<string, number>();
	for (const l of lines)
		if (l.sign === "-") removed.set(l.text.trim(), (removed.get(l.text.trim()) ?? 0) + 1);
	const added = new Map<string, number>();
	for (const l of lines)
		if (l.sign === "+") added.set(l.text.trim(), (added.get(l.text.trim()) ?? 0) + 1);
	const keep = (l: Line, other: Map<string, number>) => {
		const k = l.text.trim();
		const n = other.get(k) ?? 0;
		if (n > 0) {
			other.set(k, n - 1);
			return false;
		}
		return true;
	};
	const addedCopy = new Map(added);
	return lines.filter((l) => (l.sign === "+" ? keep(l, removed) : keep(l, addedCopy)));
};

// ---------- formatting ----------
const tty = !md && process.stdout.isTTY;
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const [bold, green, red, dim] = [c("1"), c("32"), c("31"), c("2")];
const out: string[] = [];
const h = (title: string) => out.push("", md ? `## ${title}` : bold(`== ${title} ==`));
const h3 = (title: string) => out.push(md ? `**${title}**` : bold(title));
const item = (s: string, depth = 0) =>
	out.push(`${"  ".repeat(depth)}${md ? "- " : depth ? "" : "  "}${s}`);
const code = (s: string) => (md ? `\`${s}\`` : s);
const pm = (a: number, d: number) => `${green(`+${a}`)} ${red(`-${d}`)}`;
const pct = (n: number, total: number) => `${total ? Math.round((n / total) * 100) : 0}%`;
const pad = (s: string, n: number) => s.padEnd(n);

// ---------- 1. header ----------
const commits = git("log", "--oneline", "--no-decorate", `${base}..${head}`)
	.trim()
	.split("\n")
	.filter(Boolean);
const totalAdd = stats.reduce((s, f) => s + f.add, 0);
const totalDel = stats.reduce((s, f) => s + f.del, 0);
out.push(md ? `# Review pack: \`${head}\`` : bold(`Review pack: ${head}`));
item(
	`base: ${code(base)}${pr ? ` (PR #${target})` : ""}  merge-base: ${code(mergeBase.slice(0, 8))}`,
);
item(`${stats.length} files changed, ${pm(totalAdd, totalDel)}, ${commits.length} commits`);
h("Commits");
for (const l of [...commits].reverse()) item(code(l));

// ---------- 2. size by role ----------
h("Code size by role");
const roles: Role[] = ["production", "tests", "specs+docs", "generated", "config"];
const churn = totalAdd + totalDel;
const roleRows = roles
	.map((r) => {
		const fs = stats.filter((f) => f.role === r);
		const a = fs.reduce((s, f) => s + f.add, 0);
		const d = fs.reduce((s, f) => s + f.del, 0);
		return { r, n: fs.length, a, d };
	})
	.filter((x) => x.n > 0);
if (md) {
	out.push("| role | files | added | removed | % of churn |", "|---|---:|---:|---:|---:|");
	for (const x of roleRows)
		out.push(`| ${x.r} | ${x.n} | +${x.a} | -${x.d} | ${pct(x.a + x.d, churn)} |`);
} else
	for (const x of roleRows)
		item(
			`${pad(x.r, 11)} ${pad(`${x.n} files`, 9)} ${pad(`+${x.a}`, 7)} ${pad(`-${x.d}`, 7)} ${pct(x.a + x.d, churn).padStart(4)}`,
		);

// ---------- 3. reading order ----------
type Depth = "read first (intent)" | "read closely" | "skim" | "trust";
const depthOf = (f: FileStat): Depth => {
	if (f.role === "specs+docs") return "read first (intent)";
	if (f.role === "tests" || f.role === "generated") return "trust";
	if (f.role === "config") return "skim";
	const p = f.path;
	if (/\.(css|json|svg|html)$/.test(p) || p.endsWith("/index.ts") || p.endsWith(".tsx"))
		return "skim";
	if (/^packages\/(server|contracts|shared)\//.test(p) || /(^|\/)types\.ts$/.test(p))
		return "read closely";
	const tested =
		stats.some((t) => t.path === p.replace(/\.ts$/, ".test.ts")) ||
		showAt(head, p.replace(/\.ts$/, ".test.ts")).length > 0;
	if (/\.ts$/.test(p) && (tested || f.add + f.del >= 40)) return "read closely";
	return "skim";
};
h("Reading order");
const depths: Depth[] = ["read first (intent)", "read closely", "skim", "trust"];
const byDepth = new Map(depths.map((d) => [d, stats.filter((f) => depthOf(f) === d)]));
for (const d of depths) {
	const fs = (byDepth.get(d) ?? []).sort((a, b) => b.add + b.del - (a.add + a.del));
	if (!fs.length) continue;
	const a = fs.reduce((s, f) => s + f.add, 0);
	const del = fs.reduce((s, f) => s + f.del, 0);
	h3(`${d}: ${fs.length} files, ${pm(a, del)}`);
	const width = Math.max(...fs.map((f) => f.path.length));
	for (const f of fs)
		item(`${md ? code(f.path) : pad(f.path, width)}  ${pm(f.add, f.del)}`, md ? 0 : 1);
}

// ---------- 4. public surface ----------
const declRe =
	/^(export\s+)?(declare\s+)?(default\s+)?(async\s+)?(const|let|type|interface|function\*?|class|enum|namespace)\s+(\w+)/;
const enclosingDecl = (content: string[], line: number) => {
	for (let i = line - 1; i >= 0; i--) {
		const m = declRe.exec(content[i] ?? "");
		if (m) return m[6];
		if (/^import\b/.test(content[i] ?? "")) return undefined;
	}
	return undefined;
};
const exportedNames = (content: string[]) => {
	const src = content
		.join("\n")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/.*$/gm, "");
	const names = new Set<string>();
	for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g))
		for (const part of m[1].split(",")) {
			const n = part
				.trim()
				.replace(/^type\s+/, "")
				.split(/\s+as\s+/)
				.pop();
			if (n) names.add(n);
		}
	for (const m of src.matchAll(
		/export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:const|let|function\*?|class|type|interface|enum)\s+(\w+)/g,
	))
		names.add(m[1]);
	for (const m of src.matchAll(/export\s+\*\s+(?:as\s+(\w+)\s+)?from\s+["']([^"']+)/g))
		names.add(m[1] ?? `* from ${m[2]}`);
	return names;
};
const surface: string[] = [];
// "+" only added, "-" only removed, "~" both (value changed)
const keyDiff = (net: Line[], pick: (text: string) => string | undefined) => {
	const added = new Set(net.filter((l) => l.sign === "+").flatMap((l) => pick(l.text) ?? []));
	const removed = new Set(net.filter((l) => l.sign === "-").flatMap((l) => pick(l.text) ?? []));
	return [
		...[...added].map((k) => `${removed.has(k) ? "~" : green("+")} ${code(k)}`),
		...[...removed].filter((k) => !added.has(k)).map((k) => `${red("-")} ${code(k)}`),
	];
};
const protocolOf = (ls: Line[], sign: "+" | "-") =>
	ls.flatMap((l) =>
		l.sign === sign ? (/\bPROTOCOL_VERSION\s*=\s*(\d+)/.exec(l.text)?.[1] ?? []) : [],
	)[0];
const surfaceLine = (l: Line) => `${l.sign === "+" ? green("+") : red("-")} ${code(l.text.trim())}`;
for (const f of stats) {
	const p = f.path;
	const net = netLines(linesOf(p));
	const entries: string[] = [];
	if (/(^|\/)index\.tsx?$/.test(p)) {
		const now = exportedNames(showAt(head, p));
		const was = exportedNames(showAt(mergeBase, p));
		for (const n of now) if (!was.has(n)) entries.push(`${green("+")} ${code(n)}`);
		for (const n of was) if (!now.has(n)) entries.push(`${red("-")} ${code(n)}`);
	}
	if (
		/^packages\/(contracts\/src\/.*|[^/]+\/src\/(.*\/)?types)\.ts$/.test(p) &&
		f.role === "production"
	) {
		const headC = showAt(head, p);
		const baseC = showAt(mergeBase, p);
		const groups = new Map<string, Line[]>();
		for (const l of net) {
			if (/^[\s{}()[\];,]*$/.test(l.text) || /^\s*(\/\/|\*|\/\*)/.test(l.text)) continue;
			const name = enclosingDecl(l.sign === "+" ? headC : baseC, l.line);
			if (!name) continue;
			groups.set(name, [...(groups.get(name) ?? []), l]);
		}
		for (const [name, ls] of groups) {
			const has = (c: string[]) => c.some((x) => declRe.exec(x)?.[6] === name);
			entries.push(`${name}${!has(baseC) ? " (new)" : !has(headC) ? " (removed)" : ""}:`);
			for (const l of ls.slice(0, 12)) entries.push(`  ${surfaceLine(l)}`);
			if (ls.length > 12) entries.push(`  ${dim(`... ${ls.length - 12} more lines`)}`);
		}
		const [from, to] = [protocolOf(net, "-"), protocolOf(net, "+")];
		if (to) surface.unshift(bold(`PROTOCOL_VERSION: ${from ?? "?"} -> ${to}`));
	}
	if (p === "packages/locales/en.json")
		entries.push(...keyDiff(net, (t) => /^\s*"([^"]+)"\s*:/.exec(t)?.[1]));
	if (p.endsWith(".css"))
		entries.push(
			...keyDiff(net, (t) =>
				(/^\s*(--[\w-]+)\s*:/.exec(t) ??
					/^\s*@(?:theme|utility|custom-variant)\b[^{]*/.exec(t))?.[0]
					.replace(/:$/, "")
					.trim(),
			),
		);
	if (/(^|\/)SPEC\.md$|^architecture\.md$|^goal-and-requirements\.md$/.test(p))
		for (const l of net)
			if (/^#{1,6}\s/.test(l.text))
				entries.push(`${l.sign === "+" ? green("+") : red("-")} ${l.text.trim()}`);
	if (entries.length) {
		surface.push(`${code(p)}`);
		for (const e of entries) surface.push(`  ${e}`);
	}
}
h("Public surface changes");
if (!surface.length) item(dim("none detected"));
for (const s of surface)
	out.push(md ? (s.startsWith("  ") ? `  - ${s.trim()}` : `- ${s}`) : `  ${s}`);

// ---------- 5. tests added ----------
const testRe =
	/\b(?:test|it)(?:\.(?:only|skip|each\([^)]*\)|todo|concurrent))?\(\s*(['"`])((?:\\.|(?!\1).)*)\1/;
h("Tests");
let testTotal = 0;
const removedTests: string[] = [];
for (const f of stats.filter((s) => s.role === "tests")) {
	const ls = linesOf(f.path);
	const named = (sign: "+" | "-") =>
		ls
			.filter((l) => l.sign === sign)
			.flatMap((l) => {
				const m = testRe.exec(l.text);
				return m ? [{ name: m[2], line: l.line }] : [];
			});
	const added = named("+");
	const removed = named("-");
	const addedNames = new Set(added.map((t) => t.name));
	const removedNames = new Set(removed.map((t) => t.name));
	const fresh = added.filter((t) => !removedNames.has(t.name));
	for (const t of removed)
		if (!addedNames.has(t.name)) removedTests.push(`${code(`${f.path}`)}: ${t.name}`);
	if (!fresh.length) continue;
	testTotal += fresh.length;
	h3(`${f.path} (${fresh.length} new)`);
	for (const t of fresh) item(`${dim(`${f.path}:${t.line}`)}  ${t.name}`, md ? 0 : 1);
}
if (!testTotal) item(dim("no new test names detected"));
else item(dim(`${testTotal} new tests total (renamed tests count as new)`));
if (removedTests.length) {
	h3(`Removed or renamed away (${removedTests.length})`);
	for (const t of removedTests) item(t, md ? 0 : 1);
}

// ---------- 6. union / state types ----------
interface Union {
	name: string;
	start: number;
	end: number;
	members: string[];
}
const depthDelta = (s: string) =>
	(s.match(/[{([<]/g)?.length ?? 0) -
	(s.match(/[})\]>]/g)?.length ?? 0) +
	(s.match(/=>/g)?.length ?? 0);
const splitTop = (s: string) => {
	const parts: string[] = [];
	let d = 0;
	let buf = "";
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if ("{([<".includes(ch)) d++;
		else if ("})]".includes(ch) || (ch === ">" && s[i - 1] !== "=")) d--;
		if (ch === "|" && d === 0) {
			parts.push(buf);
			buf = "";
		} else buf += ch;
	}
	return [...parts, buf].map((x) => x.trim()).filter(Boolean);
};
const label = (m: string) => {
	const disc = /\b(kind|type|status|state|tag|phase|mode)\??\s*:\s*(['"][^'"]+['"])/.exec(m);
	const s = disc ? `${disc[1]}: ${disc[2]}` : m.replace(/\s+/g, " ");
	return s.length > 70 ? `${s.slice(0, 67)}...` : s;
};
const unionsIn = (content: string[]) => {
	const res: Union[] = [];
	content.forEach((line, i) => {
		const m = /^\s*(?:export\s+)?type\s+(\w+)(?:<[^=]*>)?\s*=\s*(.*)$/.exec(line);
		if (m) {
			let text = m[2];
			let d = depthDelta(text);
			let j = i;
			while (
				j + 1 < content.length &&
				(d > 0 || /^\s*\|/.test(content[j + 1]) || (text.trim() === "" && j === i))
			) {
				j++;
				text += `\n${content[j]}`;
				d += depthDelta(content[j]);
			}
			const members = splitTop(text.replace(/;\s*$/, "").replace(/\/\/.*$/gm, ""));
			if (members.length >= 2)
				res.push({ name: m[1], start: i + 1, end: j + 1, members: members.map(label) });
		}
		const f =
			/^\s*(?:readonly\s+)?(\w+)\??\s*:\s*((?:['"][^'"]*['"]\s*\|\s*)+['"][^'"]*['"])\s*[;,]?\s*$/.exec(
				line,
			);
		if (f) res.push({ name: `.${f[1]}`, start: i + 1, end: i + 1, members: splitTop(f[2]) });
	});
	return res;
};
h("Union / state types touched");
let unionCount = 0;
for (const f of stats.filter((s) => s.role === "production" && /\.tsx?$/.test(s.path))) {
	const ls = netLines(linesOf(f.path));
	if (!ls.length) continue;
	const headU = unionsIn(showAt(head, f.path));
	const baseU = unionsIn(showAt(mergeBase, f.path));
	const hits = (u: Union, sign: "+" | "-") =>
		ls.some((l) => l.sign === sign && l.line >= u.start && l.line <= u.end);
	const rows: string[] = [];
	const seen = new Set<string>();
	for (const u of headU) {
		if (!hits(u, "+") && !baseU.some((b) => b.name === u.name && hits(b, "-"))) continue;
		const old = baseU.find((b) => b.name === u.name && b.start <= u.start + 200);
		const tag = old ? "changed" : "new";
		const mems = u.members.map((m) => (old && !old.members.includes(m) ? green(`+${m}`) : m));
		const gone = (old?.members ?? [])
			.filter((m) => !u.members.includes(m))
			.map((m) => red(`-${m}`));
		if (
			old &&
			!gone.length &&
			mems.every((m, i) => m === u.members[i]) &&
			old.members.length === u.members.length
		)
			continue;
		seen.add(u.name);
		const addedMems = mems.filter((m, i) => m !== u.members[i]);
		const body =
			old && u.members.length > 8
				? `${[...addedMems, ...gone].join(" | ")} ${dim(`(${u.members.length - addedMems.length} of ${u.members.length} unchanged)`)}`
				: [...mems, ...gone].join(" | ");
		rows.push(`${code(u.name)} (${tag}): ${body}`);
	}
	for (const b of baseU)
		if (!seen.has(b.name) && hits(b, "-") && !headU.some((u) => u.name === b.name))
			rows.push(`${code(b.name)} (removed)`);
	if (!rows.length) continue;
	unionCount += rows.length;
	h3(f.path);
	for (const r of rows) item(r, md ? 0 : 1);
}
if (!unionCount) item(dim("none detected"));

console.log(out.join("\n"));
