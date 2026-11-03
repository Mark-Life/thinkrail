import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { arr, compile, obj, oneOf, opt, str, union, unknown } from "@earendil-works/pi-schema";
import type { DetectedAccount, DetectedAccountSource } from "@thinkrail/contracts";
import { JsonObject } from "@thinkrail/contracts";
import { usePiRuntime } from "../agent";

export interface DetectAccountsOptions {
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	platform?: NodeJS.Platform;
	now?: number;
}

export interface AccountSignal {
	source: DetectedAccountSource;
	providerIds: readonly string[];
	plan?: string;
}

type Json = Record<string, unknown>;

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_CLAUDE_CONFIG_BYTES = 32 * 1024 * 1024;
const SOURCE_TIMEOUT_MS = 1500;

const KNOWN_PLANS = new Set(["plus", "pro", "max", "team", "business", "enterprise", "edu"]);

const CLAUDE_SUBSCRIPTION_BILLING = [
	"stripe_subscription",
	"stripe_subscription_contracted",
	"stripe_subscription_enterprise_self_serve",
	"aws_marketplace",
	"c4e_consumption_trial",
	"apple_subscription",
	"google_play_subscription",
] as const;

const GROK_API_KEY_SCOPE = "xai::api_key";

const Filled = str({ pattern: "\\S" });
const FilledText = compile(Filled);
const ClaudeOauth = compile(
	obj(
		{ refreshToken: Filled, scopes: arr(unknown()), subscriptionType: opt(unknown()) },
		{ open: true },
	),
);
const ClaudeSubscriber = compile(
	obj({ accountUuid: Filled, billingType: oneOf(CLAUDE_SUBSCRIPTION_BILLING) }, { open: true }),
);
const CodexTokens = compile(
	obj({ refresh_token: Filled, id_token: opt(unknown()) }, { open: true }),
);
const OpenAiClaims = compile(obj({ chatgpt_plan_type: opt(unknown()) }, { open: true }));
const CopilotHost = compile(
	union([obj({ user: Filled }, { open: true }), obj({ oauth_token: Filled }, { open: true })]),
);
const CopilotCliConfig = compile(obj({ loggedInUsers: arr(unknown()) }, { open: true }));
const CopilotCliUser = compile(obj({ login: Filled }, { open: true }));
const KimiToken = compile(obj({ refresh_token: Filled }, { open: true }));

function isObject(value: unknown): value is Json {
	return JsonObject.check(value);
}

function filled(value: unknown): value is string {
	return FilledText.check(value);
}

function envPath(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const value = env[name]?.trim();
	return value ? value : undefined;
}

const pendingReads = new Map<string, Promise<string | null>>();

async function readConfigOnce(path: string, maxBytes: number): Promise<string | null> {
	try {
		const info = await stat(path);
		if (!info.isFile() || info.size > maxBytes) return null;
		return (await readFile(path, "utf8")).replace(/^﻿/, "");
	} catch {
		return null;
	}
}

function readConfig(path: string, maxBytes: number): Promise<string | null> {
	const key = `${maxBytes}:${path}`;
	const pending = pendingReads.get(key);
	if (pending) return pending;
	const read = readConfigOnce(path, maxBytes).finally(() => pendingReads.delete(key));
	pendingReads.set(key, read);
	return read;
}

async function readJson(path: string, maxBytes = MAX_CONFIG_BYTES): Promise<Json | null> {
	const text = await readConfig(path, maxBytes);
	if (text === null) return null;
	try {
		const parsed: unknown = JSON.parse(text.replace(/^(?:\s*\/\/[^\n]*\n)+/, ""));
		return isObject(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function plan(value: unknown): { plan?: string } {
	const name = typeof value === "string" ? value.trim().toLowerCase() : "";
	return KNOWN_PLANS.has(name) ? { plan: name } : {};
}

function within<T>(work: Promise<T | null>, ms: number): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), ms);
		timer.unref?.();
	});
	return Promise.race([work.catch(() => null), timeout]).finally(() => clearTimeout(timer));
}

function jwtClaims(token: unknown): Json | null {
	if (typeof token !== "string") return null;
	const payload = token.split(".")[1];
	if (!payload) return null;
	try {
		const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		return isObject(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function expiresAfter(value: unknown, now: number): boolean {
	const at =
		typeof value === "number"
			? value < 1e12
				? value * 1000
				: value
			: typeof value === "string"
				? Date.parse(value)
				: Number.NaN;
	return at > now;
}

async function detectClaudeCode(
	env: NodeJS.ProcessEnv,
	home: string,
): Promise<AccountSignal | null> {
	const signal = (extra: { plan?: string } = {}): AccountSignal => ({
		source: "claude-code",
		providerIds: ["anthropic"],
		...extra,
	});
	if (filled(env.CLAUDE_CODE_OAUTH_TOKEN)) return signal();

	const configured = envPath(env, "CLAUDE_CONFIG_DIR");
	const configDir = configured ?? join(home, ".claude");
	const secureDir = envPath(env, "CLAUDE_SECURESTORAGE_CONFIG_DIR") ?? configDir;
	const [legacy, global, credentials] = await Promise.all([
		readJson(join(configDir, ".config.json"), MAX_CLAUDE_CONFIG_BYTES),
		readJson(join(configured ?? home, ".claude.json"), MAX_CLAUDE_CONFIG_BYTES),
		readJson(join(secureDir, ".credentials.json")),
	]);
	const oauth = credentials?.claudeAiOauth;
	if (isObject(oauth)) {
		return ClaudeOauth.check(oauth) && oauth.scopes.includes("user:inference")
			? signal(plan(oauth.subscriptionType))
			: null;
	}
	const config = legacy && Object.keys(legacy).length > 0 ? legacy : global;
	return ClaudeSubscriber.check(config?.oauthAccount) ? signal() : null;
}

function codexMode(auth: Json): unknown {
	if (auth.auth_mode !== undefined) return auth.auth_mode;
	if (
		filled(auth.personal_access_token) ||
		auth.bedrock_api_key != null ||
		auth.bedrock_access_keys != null ||
		filled(auth.OPENAI_API_KEY)
	) {
		return "apikey";
	}
	return "chatgpt";
}

async function detectCodex(env: NodeJS.ProcessEnv, home: string): Promise<AccountSignal | null> {
	const auth = await readJson(
		join(envPath(env, "CODEX_HOME") ?? join(home, ".codex"), "auth.json"),
	);
	if (!auth || codexMode(auth) !== "chatgpt") return null;
	const tokens = auth.tokens;
	if (!CodexTokens.check(tokens)) return null;
	const openai = jwtClaims(tokens.id_token)?.["https://api.openai.com/auth"];
	return {
		source: "codex",
		providerIds: ["openai", "openai-codex"],
		...plan(OpenAiClaims.check(openai) ? openai.chatgpt_plan_type : undefined),
	};
}

async function detectCopilotEditor(
	env: NodeJS.ProcessEnv,
	home: string,
	platform: NodeJS.Platform,
): Promise<AccountSignal | null> {
	const xdg = envPath(env, "XDG_CONFIG_HOME");
	const localAppData = envPath(env, "LOCALAPPDATA");
	const base =
		xdg && isAbsolute(xdg)
			? xdg
			: platform === "win32"
				? localAppData && isAbsolute(localAppData)
					? localAppData
					: join(home, "AppData", "Local")
				: join(home, ".config");
	const dir = join(base, "github-copilot");
	const files = await Promise.all([
		readJson(join(dir, "apps.json")),
		readJson(join(dir, "hosts.json")),
	]);
	const signedIn = files.some(
		(file) => file !== null && Object.values(file).some(CopilotHost.check),
	);
	return signedIn ? { source: "github-copilot", providerIds: ["github-copilot"] } : null;
}

async function detectCopilotCli(
	env: NodeJS.ProcessEnv,
	home: string,
): Promise<AccountSignal | null> {
	const config = await readJson(
		join(envPath(env, "COPILOT_HOME") ?? join(home, ".copilot"), "config.json"),
	);
	const signedIn =
		CopilotCliConfig.check(config) && config.loggedInUsers.some(CopilotCliUser.check);
	return signedIn ? { source: "copilot-cli", providerIds: ["github-copilot"] } : null;
}

async function detectKimiCli(env: NodeJS.ProcessEnv, home: string): Promise<AccountSignal | null> {
	const share = envPath(env, "KIMI_SHARE_DIR") ?? join(home, ".kimi");
	const token = await readJson(join(share, "credentials", "kimi-code.json"));
	return KimiToken.check(token) ? { source: "kimi-cli", providerIds: ["kimi-coding"] } : null;
}

async function detectGrokBuild(
	env: NodeJS.ProcessEnv,
	home: string,
	now: number,
): Promise<AccountSignal | null> {
	const path =
		envPath(env, "GROK_AUTH_PATH") ??
		join(envPath(env, "GROK_HOME") ?? join(home, ".grok"), "auth.json");
	const auth = await readJson(path);
	if (!auth) return null;
	const signedIn = Object.entries(auth).some(
		([scope, entry]) =>
			scope !== GROK_API_KEY_SCOPE &&
			isObject(entry) &&
			entry.auth_mode !== "api_key" &&
			(filled(entry.refresh_token) || expiresAfter(entry.expires_at, now)),
	);
	return signedIn ? { source: "grok-build", providerIds: ["xai"] } : null;
}

export async function detectAccountSignals(
	options: DetectAccountsOptions = {},
): Promise<AccountSignal[]> {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const home =
		options.homeDir ?? envPath(env, platform === "win32" ? "USERPROFILE" : "HOME") ?? homedir();
	const now = options.now ?? Date.now();
	const found = await Promise.all(
		[
			detectClaudeCode(env, home),
			detectCodex(env, home),
			detectCopilotEditor(env, home, platform),
			detectCopilotCli(env, home),
			detectKimiCli(env, home),
			detectGrokBuild(env, home, now),
		].map((source) => within(source, SOURCE_TIMEOUT_MS)),
	);
	return found.filter((signal) => signal !== null);
}

export function resolveDetectedAccounts(
	signals: readonly AccountSignal[],
	canOAuth: (providerId: string) => boolean,
): DetectedAccount[] {
	const seen = new Set<string>();
	return signals.flatMap((signal): DetectedAccount[] => {
		const providerId = signal.providerIds.find(canOAuth);
		if (!providerId || seen.has(providerId)) return [];
		seen.add(providerId);
		return [
			{
				providerId,
				source: signal.source,
				...(signal.plan === undefined ? {} : { plan: signal.plan }),
			},
		];
	});
}

let pendingDetection: Promise<DetectedAccount[]> | null = null;

async function detectOnce(options: DetectAccountsOptions): Promise<DetectedAccount[]> {
	const signals = await detectAccountSignals(options);
	if (signals.length === 0) return [];
	return usePiRuntime((runtime) =>
		resolveDetectedAccounts(signals, (id) => Boolean(runtime.getProvider(id)?.auth.oauth)),
	);
}

export function detectAccounts(options?: DetectAccountsOptions): Promise<DetectedAccount[]> {
	if (options) return detectOnce(options);
	pendingDetection ??= detectOnce({}).finally(() => {
		pendingDetection = null;
	});
	return pendingDetection;
}
