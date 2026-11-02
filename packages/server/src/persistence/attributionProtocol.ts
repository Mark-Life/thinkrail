import { compile, int, lit, obj, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";

export const ATTRIBUTION_ORIGIN = "https://thinkrail.ai";
export const ATTRIBUTION_POLL_INTERVAL_MS = 10_000;
export const ATTRIBUTION_MAX_POLLS = 54;
export const ATTRIBUTION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const ATTRIBUTION_POLICY_VERSION = 1 as const;

const base64UrlSha256Pattern = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
export const claimIdPattern = base64UrlSha256Pattern;
const bridgeIdPattern = base64UrlSha256Pattern;
const journeyIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const referrerClasses = ["direct", "internal", "search", "social", "referral"] as const;

const campaignBounds = {
	source: 64,
	medium: 64,
	campaign: 128,
	content: 128,
} as const;

const AttributionTouch = obj({
	source: opt(str()),
	medium: opt(str()),
	campaign: opt(str()),
	content: opt(str()),
	referrer_class: oneOf(referrerClasses),
	touched_at: int({ minimum: 0 }),
	policy_version: lit(ATTRIBUTION_POLICY_VERSION),
});
export type AttributionTouch = Static<typeof AttributionTouch>;

const ACQUISITION_FIELDS = { first_touch: AttributionTouch, last_touch: AttributionTouch };
const AcquisitionRecord = obj(ACQUISITION_FIELDS);
export type AcquisitionRecord = Static<typeof AcquisitionRecord>;
const AcquisitionFile = compile(AcquisitionRecord);

const RedeemedAttribution = obj({
	journey_id: str(),
	bridge_id: str(),
	...ACQUISITION_FIELDS,
});
export type RedeemedAttribution = Static<typeof RedeemedAttribution>;
const RedeemedReply = compile(RedeemedAttribution);

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

function touchIsCurrent(touch: AttributionTouch, now: number): boolean {
	const campaignValuesAreNormal = (["source", "medium", "campaign", "content"] as const).every(
		(key) => {
			const value = touch[key];
			return value === undefined || normalizeCampaignValue(value, campaignBounds[key]) === value;
		},
	);
	return campaignValuesAreNormal && touch.touched_at <= now + 60_000;
}

function acquisitionIsCurrent(record: AcquisitionRecord, now: number): boolean {
	return (
		touchIsCurrent(record.first_touch, now) &&
		touchIsCurrent(record.last_touch, now) &&
		record.first_touch.touched_at <= record.last_touch.touched_at &&
		record.last_touch.touched_at >= now - ATTRIBUTION_LIFETIME_MS
	);
}

export function parseAcquisitionRecord(value: unknown, now: number): AcquisitionRecord | undefined {
	return AcquisitionFile.check(value) && acquisitionIsCurrent(value, now) ? value : undefined;
}

export function parseRedeemedAttribution(
	value: unknown,
	now: number,
): RedeemedAttribution | undefined {
	return RedeemedReply.check(value) &&
		journeyIdPattern.test(value.journey_id) &&
		bridgeIdPattern.test(value.bridge_id) &&
		acquisitionIsCurrent(value, now)
		? value
		: undefined;
}
