import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

export const ATTRIBUTION_ORIGIN = "https://thinkrail.ai";
export const ATTRIBUTION_POLL_INTERVAL_MS = 10_000;
export const ATTRIBUTION_MAX_POLLS = 54;
export const ATTRIBUTION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const ATTRIBUTION_POLICY_VERSION = 1 as const;

const base64UrlSha256Pattern = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
export const claimIdPattern = base64UrlSha256Pattern;
export const bridgeIdPattern = base64UrlSha256Pattern;
export const journeyIdPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const closed = { additionalProperties: false };
const timestamp = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

const TouchSchema = Type.Object(
	{
		source: Type.Optional(Type.String()),
		medium: Type.Optional(Type.String()),
		campaign: Type.Optional(Type.String()),
		content: Type.Optional(Type.String()),
		referrer_class: Type.Union([
			Type.Literal("direct"),
			Type.Literal("internal"),
			Type.Literal("search"),
			Type.Literal("social"),
			Type.Literal("referral"),
		]),
		touched_at: timestamp,
		policy_version: Type.Literal(ATTRIBUTION_POLICY_VERSION),
	},
	closed,
);
const AcquisitionRecordSchema = Type.Object(
	{ first_touch: TouchSchema, last_touch: TouchSchema },
	closed,
);
const RedeemedAttributionSchema = Type.Object(
	{
		journey_id: Type.String(),
		bridge_id: Type.String(),
		first_touch: TouchSchema,
		last_touch: TouchSchema,
	},
	closed,
);

export type AttributionTouch = Static<typeof TouchSchema>;
export type ReferrerClass = AttributionTouch["referrer_class"];
export type AcquisitionRecord = Static<typeof AcquisitionRecordSchema>;
export type RedeemedAttribution = Static<typeof RedeemedAttributionSchema>;

const campaignBounds = {
	source: 64,
	medium: 64,
	campaign: 128,
	content: 128,
} as const;

function normalizeCampaignValue(value: string, limit: number): string | undefined {
	const withoutControls = Array.from(value)
		.filter((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint > 31 && (codePoint < 127 || codePoint > 159);
		})
		.join("");
	const normalized = Array.from(withoutControls.trim()).slice(0, limit).join("");
	return normalized.length > 0 ? normalized : undefined;
}

function normalizedCampaignValue(candidate: string | undefined, limit: number): boolean {
	return candidate === undefined || normalizeCampaignValue(candidate, limit) === candidate;
}

function validTouch(touch: AttributionTouch, now: number): boolean {
	return (
		touch.touched_at <= now + 60_000 &&
		normalizedCampaignValue(touch.source, campaignBounds.source) &&
		normalizedCampaignValue(touch.medium, campaignBounds.medium) &&
		normalizedCampaignValue(touch.campaign, campaignBounds.campaign) &&
		normalizedCampaignValue(touch.content, campaignBounds.content)
	);
}

export function parseAcquisitionRecord(value: unknown, now: number): AcquisitionRecord | undefined {
	if (!Check(AcquisitionRecordSchema, value)) return undefined;
	const { first_touch: firstTouch, last_touch: lastTouch } = value;
	if (
		!validTouch(firstTouch, now) ||
		!validTouch(lastTouch, now) ||
		firstTouch.touched_at > lastTouch.touched_at ||
		lastTouch.touched_at < now - ATTRIBUTION_LIFETIME_MS
	) {
		return undefined;
	}
	return value;
}

export function parseRedeemedAttribution(
	value: unknown,
	now: number,
): RedeemedAttribution | undefined {
	if (
		!Check(RedeemedAttributionSchema, value) ||
		!journeyIdPattern.test(value.journey_id) ||
		!bridgeIdPattern.test(value.bridge_id)
	) {
		return undefined;
	}
	const { first_touch, last_touch } = value;
	return parseAcquisitionRecord({ first_touch, last_touch }, now) ? value : undefined;
}
