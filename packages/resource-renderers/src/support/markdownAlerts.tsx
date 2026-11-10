import {
	RiErrorWarningLine as CircleAlert,
	RiInformationLine as Info,
	RiLightbulbLine as Lightbulb,
	RiAlarmWarningLine as OctagonAlert,
	type RemixiconComponentType,
	RiAlertLine as TriangleAlert,
} from "@remixicon/react";
import type { MessageKey } from "@thinkrail/locales";
import { useT } from "@thinkrail/locales/react";
import type { ReactNode } from "react";
import type { ExtraProps } from "react-markdown";

const ALERT_VARIANTS = ["note", "tip", "important", "warning", "caution"] as const;
export type AlertVariant = (typeof ALERT_VARIANTS)[number];

const MARKER = /^\[!(note|tip|important|warning|caution)\]/i;

export function parseAlertMarker(text: string): { variant: AlertVariant; rest: string } | null {
	const m = MARKER.exec(text);
	const marker = m?.[0];
	const variant = alertVariant(m?.[1]?.toLowerCase());
	if (!marker || !variant) return null;
	const rest = text.slice(marker.length).replace(/^[^\S\n]*\n?/, "");
	return { variant, rest };
}

interface MdNode {
	type: string;
	value?: string;
	children?: MdNode[];
	data?: { hName?: string; hProperties?: Record<string, unknown> };
}

export function remarkGithubAlerts() {
	return (tree: MdNode): void => walk(tree);
}

function walk(node: MdNode): void {
	if (!node.children) return;
	for (const child of node.children) {
		if (child.type === "blockquote") transformBlockquote(child);
		walk(child);
	}
}

function transformBlockquote(bq: MdNode): void {
	const firstPara = bq.children?.[0];
	if (firstPara?.type !== "paragraph") return;
	const firstText = firstPara.children?.[0];
	if (firstText?.type !== "text" || typeof firstText.value !== "string") return;
	const parsed = parseAlertMarker(firstText.value);
	if (!parsed) return;
	firstText.value = parsed.rest;
	if (parsed.rest === "" && firstPara.children?.length === 1) bq.children?.shift();
	bq.data = {
		...bq.data,
		hName: "mdalert",
		hProperties: { ...bq.data?.hProperties, variant: parsed.variant },
	};
}

const ALERTS: Record<
	AlertVariant,
	{
		label: MessageKey;
		icon: RemixiconComponentType;
		border: string;
		bg: string;
		text: string;
	}
> = {
	note: {
		label: "panels.markdownAlerts.note",
		icon: Info,
		border: "border-feedback-info",
		bg: "bg-feedback-info-subtle",
		text: "text-feedback-info",
	},
	tip: {
		label: "panels.markdownAlerts.tip",
		icon: Lightbulb,
		border: "border-feedback-success",
		bg: "bg-feedback-success-subtle",
		text: "text-feedback-success",
	},
	important: {
		label: "panels.markdownAlerts.important",
		icon: CircleAlert,
		border: "border-primary",
		bg: "bg-primary-subtle",
		text: "text-primary",
	},
	warning: {
		label: "panels.markdownAlerts.warning",
		icon: TriangleAlert,
		border: "border-feedback-warning",
		bg: "bg-feedback-warning-subtle",
		text: "text-feedback-warning",
	},
	caution: {
		label: "panels.markdownAlerts.caution",
		icon: OctagonAlert,
		border: "border-feedback-error",
		bg: "bg-feedback-error-subtle",
		text: "text-feedback-error",
	},
};

function alertVariant(value: unknown): AlertVariant | undefined {
	return ALERT_VARIANTS.find((variant) => variant === value);
}

function AlertCallout({ node, children }: ExtraProps & { children?: ReactNode }) {
	const t = useT();
	const variant = alertVariant(node?.properties?.variant) ?? "note";
	const cfg = ALERTS[variant];
	const Icon = cfg.icon;
	return (
		<div
			data-testid="md-alert"
			data-variant={variant}
			className={`my-12 rounded-r-sm border-l-2 py-8 pr-12 pl-12 text-text-default ${cfg.border} ${cfg.bg} [&>*:last-child]:mb-0 [&_p]:my-4`}
		>
			<p className={`tr-title-card mb-4 flex items-center gap-4 ${cfg.text}`}>
				<Icon className="size-16 shrink-0" />
				{t(cfg.label)}
			</p>
			{children}
		</div>
	);
}

export const alertComponents = { mdalert: AlertCallout };
