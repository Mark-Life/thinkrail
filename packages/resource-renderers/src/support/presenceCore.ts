import type { PresenceTone, PresenceWrite, PresenceWriter, TextChange } from "../registry";
import {
	joinDiffs,
	PRESENCE_TIMING,
	type PresencePaint,
	type PresenceSpan,
	presencePaint,
} from "./presenceDecorations";

export interface DiskLanding {
	hash: string;
	before: string;
	changes: readonly TextChange[];
}

export interface PresenceText {
	hover(writer: PresenceWriter): string;
	lines(writer: PresenceWriter, spans: readonly PresenceSpan[]): string;
	places(writer: PresenceWriter, count: number): string;
	file(name: string): string;
}

export interface PresenceLook {
	writer: PresenceWriter;
	step: number;
	label: string;
	diff: readonly string[];
}

export interface PresenceRanges {
	spans(): PresenceSpan[];
	paint(look: PresenceLook): void;
	append(spans: readonly PresenceSpan[]): void;
	set(spans: readonly PresenceSpan[]): void;
	clear(): void;
}

export interface PresenceSurface {
	track(spans: readonly PresenceSpan[]): PresenceRanges | null;
	flag(ranges: PresenceRanges, node: HTMLElement): () => void;
	chip(node: HTMLElement): () => void;
}

interface Mark {
	hash: string;
	paint: PresencePaint;
	ranges: PresenceRanges;
	writer: PresenceWriter | null;
	announcedAt: number;
	flag: (() => void) | null;
	chip: (() => void) | null;
	timers: ReturnType<typeof setTimeout>[];
}

const ANNOUNCED_SPANS_MAX = 5;

export function presenceClasses(writer: PresenceWriter): string {
	return `presence-tone-${writer.tone}${writer.inferred ? " presence-inferred" : ""}`;
}

function badge(kind: "flag" | "chip", writer: PresenceWriter): HTMLElement {
	const node = document.createElement("div");
	node.className = `presence-${kind} ${presenceClasses(writer)}`;
	node.dataset.presence = kind;
	node.dataset.writer = writer.id;
	node.setAttribute("aria-hidden", "true");
	return node;
}

function flagNode(writer: PresenceWriter, iconMarkup: string): HTMLElement {
	const node = badge("flag", writer);
	const body = document.createElement("span");
	body.className = "presence-flag-body rounded-full";
	const icon = document.createElement("span");
	icon.className = "presence-flag-icon";
	icon.innerHTML = iconMarkup;
	const name = document.createElement("span");
	name.className = "presence-flag-name";
	name.textContent = writer.label;
	body.append(icon, name);
	node.append(body);
	return node;
}

function chipNode(writer: PresenceWriter, text: string): HTMLElement {
	const node = badge("chip", writer);
	node.textContent = text;
	return node;
}

export interface PresenceOptions {
	text: () => PresenceText;
	announce(message: string): void;
	icon(tone: PresenceTone): string;
}

export function createPresenceMarks(surface: PresenceSurface, options: PresenceOptions) {
	let latest: PresenceWrite | undefined;
	const marks = new Set<Mark>();
	const writerOf = (hash: string) => (latest?.hash === hash ? latest.writer : undefined);
	const firstLine = (mark: Mark) => mark.ranges.spans()[0]?.startLine;

	const clearFlag = (mark: Mark) => {
		mark.flag?.();
		mark.flag = null;
	};
	const clearChip = (mark: Mark) => {
		mark.chip?.();
		mark.chip = null;
	};
	const drop = (mark: Mark) => {
		for (const timer of mark.timers) clearTimeout(timer);
		clearFlag(mark);
		clearChip(mark);
		mark.ranges.clear();
		marks.delete(mark);
	};

	const render = (mark: Mark, step: number) => {
		const writer = mark.writer;
		if (!writer || mark.paint.kind !== "lines") return;
		mark.ranges.paint({ writer, step, label: options.text().hover(writer), diff: mark.paint.diff });
	};

	const showFlag = (mark: Mark, writer: PresenceWriter) => {
		const at = firstLine(mark);
		for (const other of marks) {
			if (other !== mark && firstLine(other) === at) clearFlag(other);
		}
		mark.flag = surface.flag(mark.ranges, flagNode(writer, options.icon(writer.tone)));
	};

	const showChip = (mark: Mark, writer: PresenceWriter) => {
		let earlier = true;
		for (const other of [...marks]) {
			if (other === mark) earlier = false;
			else if (earlier || other.paint.kind === "file") drop(other);
		}
		mark.chip = surface.chip(chipNode(writer, options.text().file(writer.label)));
	};

	const absorb = (mark: Mark, writer: PresenceWriter) => {
		if (mark.paint.kind !== "lines") return;
		const own = mark.ranges.spans();
		const covered = (span: PresenceSpan) =>
			own.some((mine) => mine.startLine <= span.startLine && mine.endLine >= span.endLine);
		for (const other of [...marks]) {
			if (other === mark || other.writer?.id !== writer.id || other.paint.kind !== "lines")
				continue;
			const theirs = other.ranges.spans();
			const rest = theirs.filter((span) => !covered(span));
			if (other.writer.inferred !== writer.inferred) {
				if (rest.length === 0) drop(other);
				else if (rest.length < theirs.length) {
					other.ranges.set(rest);
					render(other, PRESENCE_TIMING.washSteps);
				}
				continue;
			}
			mark.ranges.append(rest);
			mark.paint = { ...mark.paint, diff: joinDiffs(mark.paint.diff, other.paint.diff) };
			mark.announcedAt = Math.max(mark.announcedAt, other.announcedAt);
			drop(other);
		}
	};

	const paint = (mark: Mark, writer: PresenceWriter) => {
		for (const timer of mark.timers) clearTimeout(timer);
		const now = Date.now();
		mark.writer = writer;
		const text = options.text();
		if (mark.paint.kind === "file") {
			showChip(mark, writer);
			options.announce(text.file(writer.spoken));
			mark.timers = [setTimeout(() => drop(mark), PRESENCE_TIMING.chipMs)];
			return;
		}
		const spans = mark.ranges.spans();
		absorb(mark, writer);
		render(mark, 0);
		showFlag(mark, writer);
		if (spans.length > 0 && now - mark.announcedAt >= PRESENCE_TIMING.flagMs) {
			mark.announcedAt = now;
			options.announce(
				spans.length > ANNOUNCED_SPANS_MAX
					? text.places(writer, spans.length)
					: text.lines(writer, spans),
			);
		}
		const washStep = PRESENCE_TIMING.washMs / PRESENCE_TIMING.washSteps;
		mark.timers = [
			...Array.from({ length: PRESENCE_TIMING.washSteps }, (_, index) =>
				setTimeout(() => render(mark, index + 1), (index + 1) * washStep),
			),
			setTimeout(() => clearFlag(mark), PRESENCE_TIMING.flagMs),
			setTimeout(() => drop(mark), PRESENCE_TIMING.holdMs),
		];
	};

	return {
		land(landing: DiskLanding) {
			const result = presencePaint(landing);
			if (!result) return;
			const ranges = surface.track(result.kind === "lines" ? result.spans : []);
			if (!ranges) return;
			const mark: Mark = {
				hash: landing.hash,
				paint: result,
				ranges,
				writer: null,
				announcedAt: Number.NEGATIVE_INFINITY,
				flag: null,
				chip: null,
				timers: [],
			};
			marks.add(mark);
			const writer = writerOf(landing.hash);
			if (writer) paint(mark, writer);
			else mark.timers = [setTimeout(() => drop(mark), PRESENCE_TIMING.pendingMs)];
		},
		setLatest(next: PresenceWrite | undefined) {
			latest = next;
			for (const mark of [...marks]) {
				if (!marks.has(mark)) continue;
				const writer = mark.writer ? undefined : writerOf(mark.hash);
				if (writer) paint(mark, writer);
			}
		},
		dispose() {
			for (const mark of [...marks]) drop(mark);
		},
	};
}
