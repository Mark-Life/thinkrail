import { arr, compile, int, obj, opt, type Static, str } from "@earendil-works/pi-schema";
import {
	type PlanReviewResult,
	PlanReviewVerdict,
	REVIEW_READING_ORDER_LIMIT,
	ReviewCommentKind,
	type ReviewFixComment,
} from "@thinkrail/contracts";

const Filled = str({ minLength: 1 });
const Line = int({ minimum: 1 });

const ReviewerFinding = obj(
	{
		id: Filled,
		body: Filled,
		kind: opt(ReviewCommentKind),
		path: opt(str()),
		startLine: opt(Line),
		endLine: opt(Line),
	},
	{ open: true },
);

/** The reviewer subagent's JSON reply: model output, so every field is checked. */
const ReviewerReply = compile(
	obj(
		{
			verdict: PlanReviewVerdict,
			summary: opt(str()),
			readingOrder: opt(
				arr(obj({ path: Filled, why: Filled }, { open: true }), {
					maxItems: REVIEW_READING_ORDER_LIMIT,
				}),
			),
			findings: arr(ReviewerFinding),
		},
		{ open: true },
	),
);

function coherentLines(finding: Static<typeof ReviewerFinding>): boolean {
	const { path, startLine, endLine } = finding;
	if (startLine !== undefined && path === undefined) return false;
	if (endLine !== undefined && startLine === undefined) return false;
	return startLine === undefined || endLine === undefined || endLine >= startLine;
}

function agentPath(path: string): string {
	return path.replaceAll("\\", "/");
}

export function parseVerdict(
	finalText: string | undefined,
	itemId: string,
	itemTitle: string,
): PlanReviewResult | null {
	if (!finalText) return null;
	const fenced = /```json\s*([\s\S]*?)```/gi.exec(finalText);
	const raw = fenced?.[1] ?? finalText;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.trim());
	} catch {
		return null;
	}
	if (!ReviewerReply.check(parsed) || !parsed.findings.every(coherentLines)) return null;
	if (parsed.verdict === "request_changes" && parsed.findings.length === 0) return null;
	const findings: ReviewFixComment[] = parsed.findings.map((f) => ({
		id: f.id,
		kind: f.kind ?? "inline",
		body: f.body,
		...(f.path ? { path: agentPath(f.path) } : {}),
		...(f.startLine !== undefined ? { startLine: f.startLine } : {}),
		...(f.endLine !== undefined ? { endLine: f.endLine } : {}),
	}));
	// Construct explicitly, never spread the model object: `blockedByOpenFindings` is host-set only, so a
	// hallucinated value must not survive an approve. See planReview.SPEC.md.
	return {
		verdict: parsed.verdict,
		itemId,
		itemTitle,
		...(parsed.summary !== undefined ? { summary: parsed.summary } : {}),
		...(parsed.readingOrder !== undefined
			? {
					readingOrder: parsed.readingOrder.map((step) => ({
						path: agentPath(step.path),
						why: step.why,
					})),
				}
			: {}),
		findings,
	};
}

export type VerdictOutcome =
	| { kind: "approved" }
	| { kind: "approve-blocked"; openFindings: number }
	| { kind: "changes"; canAutoFix: boolean; findings?: ReviewFixComment[] };

export function composeText(result: PlanReviewResult, outcome: VerdictOutcome): string {
	const list = outcome.kind === "changes" ? (outcome.findings ?? result.findings) : result.findings;
	const findings =
		list.length > 0
			? `\n\n${list
					.map((f) => {
						const loc = f.path
							? ` (${f.path}${f.startLine ? `:${f.startLine}${f.endLine && f.endLine !== f.startLine ? `-${f.endLine}` : ""}` : ""})`
							: "";
						return `- [${f.id}]${loc} ${f.body}`;
					})
					.join("\n")}`
			: "";
	const rationale = result.summary ? `\n\n${result.summary}` : "";
	if (outcome.kind === "approved") {
		return `Review verdict: APPROVE — step "${result.itemTitle}".${rationale}${findings}`;
	}
	if (outcome.kind === "approve-blocked") {
		const n = outcome.openFindings;
		return (
			`Review verdict: APPROVE — step "${result.itemTitle}" — but it is NOT settled: ` +
			`${n} earlier finding${n === 1 ? "" : "s"} on this step ${n === 1 ? "is" : "are"} still open in Review. ` +
			`Resolve each one you actually addressed with resolve_comment, then request_review again.${rationale}${findings}`
		);
	}
	const head = `Review verdict: REQUEST_CHANGES — step "${result.itemTitle}".`;
	const next = outcome.canAutoFix
		? "Fix each finding below NOW without asking the user: set the step back to in_progress (todo_update), apply the fixes, mark it done, then call request_review again."
		: "The automated fix cycle is spent or auto-fix is off: do NOT fix now. Report these findings to the user and wait for their direction.";
	return `${head} ${next}${rationale}${findings}`;
}
