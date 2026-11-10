import { beforeEach, expect, test } from "bun:test";
import { ANALYTICS_CONSENT_PROTOCOL_VERSION, DEFAULT_CONFIG } from "@thinkrail/contracts";
import { useAppStore } from "./appStore";
import { selectAnalyticsConsentPromptOpen, selectAnalyticsConsentSupported } from "./selectors";

beforeEach(() => {
	useAppStore.setState(useAppStore.getInitialState(), true);
});

test("analytics preference and explicit consent start independently off", () => {
	expect(useAppStore.getState()).toMatchObject({
		analyticsEnabled: false,
		analyticsConsentConfirmed: false,
	});
	expect(selectAnalyticsConsentPromptOpen(useAppStore.getState())).toBe(false);
});

for (const preference of [true, false]) {
	for (const confirmation of [true, false]) {
		test(`analytics config projects preference ${preference} and confirmation ${confirmation} independently`, () => {
			const config = {
				...DEFAULT_CONFIG,
				analyticsEnabled: preference,
				analyticsConsentConfirmed: confirmation,
			};
			const expected = {
				analyticsEnabled: preference,
				analyticsConsentConfirmed: confirmation,
			};
			useAppStore.getState().applyConfig(config);
			expect(useAppStore.getState()).toMatchObject(expected);
			useAppStore.setState(useAppStore.getInitialState(), true);
			useAppStore
				.getState()
				.installWelcomeSnapshot(ANALYTICS_CONSENT_PROTOCOL_VERSION, [], [], config);
			expect(useAppStore.getState()).toMatchObject(expected);
			expect(selectAnalyticsConsentPromptOpen(useAppStore.getState())).toBe(
				!expected.analyticsConsentConfirmed,
			);
		});
	}
}

test("an unconfirmed saved true preference remains unconfirmed and opens the prompt", () => {
	const { analyticsConsentConfirmed: _confirmation, ...legacy } = DEFAULT_CONFIG;
	useAppStore.getState().installWelcomeSnapshot(ANALYTICS_CONSENT_PROTOCOL_VERSION, [], [], {
		...legacy,
		analyticsEnabled: true,
	});
	expect(useAppStore.getState()).toMatchObject({
		analyticsEnabled: true,
		analyticsConsentConfirmed: false,
	});
	expect(selectAnalyticsConsentPromptOpen(useAppStore.getState())).toBe(true);
});

test("capability requires the current host's v65 welcome, not connection status", () => {
	for (const protocolVersion of [null, 0, ANALYTICS_CONSENT_PROTOCOL_VERSION - 1]) {
		const state = { protocolVersion, welcomeGeneration: 1, analyticsConsentConfirmed: false };
		expect(selectAnalyticsConsentSupported(state)).toBe(false);
		expect(selectAnalyticsConsentPromptOpen(state)).toBe(false);
	}
	for (const protocolVersion of [
		ANALYTICS_CONSENT_PROTOCOL_VERSION,
		ANALYTICS_CONSENT_PROTOCOL_VERSION + 1,
	]) {
		const state = { protocolVersion, welcomeGeneration: 0, analyticsConsentConfirmed: false };
		expect(selectAnalyticsConsentSupported(state)).toBe(true);
		expect(selectAnalyticsConsentPromptOpen(state)).toBe(false);
		expect(selectAnalyticsConsentPromptOpen({ ...state, welcomeGeneration: 1 })).toBe(true);
		expect(
			selectAnalyticsConsentPromptOpen({
				...state,
				welcomeGeneration: 1,
				analyticsConsentConfirmed: true,
			}),
		).toBe(false);
	}
});

test("confirmed settings converge through broadcasts and subsequent welcomes without prompting again", () => {
	const store = useAppStore.getState;
	store().setStatus("connected");
	store().installWelcomeSnapshot(ANALYTICS_CONSENT_PROTOCOL_VERSION, [], [], DEFAULT_CONFIG);
	expect(selectAnalyticsConsentPromptOpen(store())).toBe(true);
	for (const analyticsEnabled of [true, false]) {
		const config = { ...DEFAULT_CONFIG, analyticsEnabled, analyticsConsentConfirmed: true };
		store().applyConfig(config);
		expect(selectAnalyticsConsentPromptOpen(store())).toBe(false);
		store().setStatus("disconnected");
		expect(selectAnalyticsConsentSupported(store())).toBe(false);
		expect(selectAnalyticsConsentPromptOpen(store())).toBe(false);
		store().setStatus("connected");
		expect(selectAnalyticsConsentPromptOpen(store())).toBe(false);
		store().installWelcomeSnapshot(ANALYTICS_CONSENT_PROTOCOL_VERSION, [], [], config);
		expect(selectAnalyticsConsentPromptOpen(store())).toBe(false);
	}
});
