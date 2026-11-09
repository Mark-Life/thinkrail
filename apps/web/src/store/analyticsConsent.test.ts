import { beforeEach, expect, test } from "bun:test";
import { type AppConfig, DEFAULT_CONFIG, PROTOCOL_VERSION } from "@thinkrail/contracts";
import { useAppStore } from "./appStore";
import { selectAnalyticsConsentPromptOpen, selectHostWelcomed } from "./selectors";

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

for (const preference of [true, false, undefined, "true", null, 1]) {
	for (const confirmation of [true, false, undefined, "true", null, 1]) {
		test(`analytics config normalizes preference ${JSON.stringify(preference)} and confirmation ${JSON.stringify(confirmation)} independently`, () => {
			const config = {
				...DEFAULT_CONFIG,
				analyticsEnabled: preference,
				analyticsConsentConfirmed: confirmation,
			} as AppConfig;
			const expected = {
				analyticsEnabled: preference === true,
				analyticsConsentConfirmed: confirmation === true,
			};
			useAppStore.getState().applyConfig(config);
			expect(useAppStore.getState()).toMatchObject(expected);
			useAppStore.setState(useAppStore.getInitialState(), true);
			useAppStore.getState().installWelcomeSnapshot(PROTOCOL_VERSION, [], [], config);
			expect(useAppStore.getState()).toMatchObject(expected);
			expect(selectAnalyticsConsentPromptOpen(useAppStore.getState())).toBe(
				!expected.analyticsConsentConfirmed,
			);
		});
	}
}

test("an unconfirmed saved true preference remains unconfirmed and opens the prompt", () => {
	const { analyticsConsentConfirmed: _confirmation, ...legacy } = DEFAULT_CONFIG;
	useAppStore.getState().installWelcomeSnapshot(PROTOCOL_VERSION, [], [], {
		...legacy,
		analyticsEnabled: true,
	} as AppConfig);
	expect(useAppStore.getState()).toMatchObject({
		analyticsEnabled: true,
		analyticsConsentConfirmed: false,
	});
	expect(selectAnalyticsConsentPromptOpen(useAppStore.getState())).toBe(true);
});

test("the prompt requires the current host's welcome, not connection status", () => {
	expect(
		selectAnalyticsConsentPromptOpen({
			protocolVersion: null,
			welcomeGeneration: 1,
			analyticsConsentConfirmed: false,
		}),
	).toBe(false);
	const state = {
		protocolVersion: PROTOCOL_VERSION,
		welcomeGeneration: 0,
		analyticsConsentConfirmed: false,
	};
	expect(selectHostWelcomed(state)).toBe(true);
	expect(selectAnalyticsConsentPromptOpen(state)).toBe(false);
	expect(selectAnalyticsConsentPromptOpen({ ...state, welcomeGeneration: 1 })).toBe(true);
	expect(
		selectAnalyticsConsentPromptOpen({
			...state,
			welcomeGeneration: 1,
			analyticsConsentConfirmed: true,
		}),
	).toBe(false);
});

test("confirmed settings converge through broadcasts and subsequent welcomes without prompting again", () => {
	const store = useAppStore.getState;
	store().setStatus("connected");
	store().installWelcomeSnapshot(PROTOCOL_VERSION, [], [], DEFAULT_CONFIG);
	expect(selectAnalyticsConsentPromptOpen(store())).toBe(true);
	for (const analyticsEnabled of [true, false]) {
		const config = { ...DEFAULT_CONFIG, analyticsEnabled, analyticsConsentConfirmed: true };
		store().applyConfig(config);
		expect(selectAnalyticsConsentPromptOpen(store())).toBe(false);
		store().setStatus("disconnected");
		expect(selectHostWelcomed(store())).toBe(false);
		expect(selectAnalyticsConsentPromptOpen(store())).toBe(false);
		store().setStatus("connected");
		expect(selectAnalyticsConsentPromptOpen(store())).toBe(false);
		store().installWelcomeSnapshot(PROTOCOL_VERSION, [], [], config);
		expect(selectAnalyticsConsentPromptOpen(store())).toBe(false);
	}
});
