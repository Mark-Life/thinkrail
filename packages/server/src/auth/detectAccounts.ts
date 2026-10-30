import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { DetectedAccount, DetectedAccountSource } from "@thinkrail/contracts";
import { type Static, type TSchema, Type } from "typebox";
import { Check } from "typebox/value";
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

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_CLAUDE_CONFIG_BYTES = 32 * 1024 * 1024;
const SOURCE_TIMEOUT_MS = 1500;

const KNOWN_PLANS = new Set(["plus", "pro", "max", "team", "business", "enterprise", "edu"]);

const CLAUDE_SUBSCRIPTION_BILLING = new Set([
	"stripe_subscription",
	"stripe_subscription_contracted",
	"stripe_subscription_enterprise_self_serve",
	"aws_marketplace",
	"c4e_consumption_trial",
	"apple_subscription",
	"google_play_subscription",
]);

const GROK_API_KEY_SCOPE = "xai::api_key";

const Filled = Type.String({ pattern: "\\S" });
const AnyObject = Type.Object({});
const Opaque = Type.Optional(Type.Unknown());
const ClaudeConfigSchema = Type.Object({ oauthAccount: Opaque });
const ClaudeCredentialsSchema = Type.Object({ claudeAiOauth: Opaque });
const ClaudeOauthSchema = Type.Object({
	refreshToken: Filled,
	scopes: Type.Array(Type.Unknown()),
	subscriptionType: Type.Optional(Type.String()),
});
const ClaudeAccountSchema = Type.Object({ accountUuid: Filled, billingType: Type.String() });
const CodexAuthSchema = Type.Object({
	auth_mode: Opaque,
	personal_access_token: Opaque,
	bedrock_api_key: Opaque,
	bedrock_access_keys: Opaque,
	OPENAI_API_KEY: Opaque,
	tokens: Opaque,
});
const CodexTokensSchema = Type.Object({ refresh_token: Filled, id_token: Opaque });
const JwtClaimsSchema = Type.Object({
	"https://api.openai.com/auth": Type.Optional(
		Type.Object({ chatgpt_plan_type: Type.Optional(Type.String()) }),
	),
});
const Dictionary = Type.Record(Type.String(), Type.Unknown());
const CopilotEditorEntrySchema = Type.Union([
	Type.Object({ user: Filled }),
	Type.Object({ oauth_token: Filled }),
]);
const CopilotCliConfigSchema = Type.Object({ loggedInUsers: Type.Array(Type.Unknown()) });
const CopilotCliUserSchema = Type.Object({ login: Filled });
const KimiCredentialsSchema = Type.Object({ refresh_token: Filled });
const GrokEntrySchema = Type.Object({
	auth_mode: Opaque,
	refresh_token: Opaque,
	expires_at: Type.Optional(Type.Union([Type.Number(), Type.String()])),
});

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

async function readJson<Schema extends TSchema>(
	path: string,
	schema: Schema,
	maxBytes = MAX_CONFIG_BYTES,
): Promise<Static<Schema> | null> {
	const text = await readConfig(path, maxBytes);
	if (text === null) return null;
	try {
		const parsed: unknown = JSON.parse(text.replace(/^(?:\s*\/\/[^\n]*\n)+/, ""));
		return Check(schema, parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function plan(value: string | undefined): { plan?: string } {
	const name = value?.trim().toLowerCase() ?? "";
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

function jwtClaims(token: string): Static<typeof JwtClaimsSchema> | null {
	const payload = token.split(".")[1];
	if (!payload) return null;
	try {
		const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		return Check(JwtClaimsSchema, parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function expiresAfter(value: number | string | undefined, now: number): boolean {
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
	if (Check(Filled, env.CLAUDE_CODE_OAUTH_TOKEN)) return signal();

	const configured = envPath(env, "CLAUDE_CONFIG_DIR");
	const configDir = configured ?? join(home, ".claude");
	const secureDir = envPath(env, "CLAUDE_SECURESTORAGE_CONFIG_DIR") ?? configDir;
	const [legacy, global, credentials] = await Promise.all([
		readJson(join(configDir, ".config.json"), ClaudeConfigSchema, MAX_CLAUDE_CONFIG_BYTES),
		readJson(join(configured ?? home, ".claude.json"), ClaudeConfigSchema, MAX_CLAUDE_CONFIG_BYTES),
		readJson(join(secureDir, ".credentials.json"), ClaudeCredentialsSchema),
	]);
	const oauth = credentials?.claudeAiOauth;
	if (Check(AnyObject, oauth)) {
		return Check(ClaudeOauthSchema, oauth) && oauth.scopes.includes("user:inference")
			? signal(plan(oauth.subscriptionType))
			: null;
	}
	const config = legacy && Object.keys(legacy).length > 0 ? legacy : global;
	const account = config?.oauthAccount;
	return Check(ClaudeAccountSchema, account) && CLAUDE_SUBSCRIPTION_BILLING.has(account.billingType)
		? signal()
		: null;
}

function isCodexChatgptMode(auth: Static<typeof CodexAuthSchema>): boolean {
	if (auth.auth_mode !== undefined) return auth.auth_mode === "chatgpt";
	return !(
		Check(Filled, auth.personal_access_token) ||
		auth.bedrock_api_key != null ||
		auth.bedrock_access_keys != null ||
		Check(Filled, auth.OPENAI_API_KEY)
	);
}

async function detectCodex(env: NodeJS.ProcessEnv, home: string): Promise<AccountSignal | null> {
	const auth = await readJson(
		join(envPath(env, "CODEX_HOME") ?? join(home, ".codex"), "auth.json"),
		CodexAuthSchema,
	);
	if (!auth || !isCodexChatgptMode(auth)) return null;
	const tokens = auth.tokens;
	if (!Check(CodexTokensSchema, tokens)) return null;
	const claims = Check(Type.String(), tokens.id_token) ? jwtClaims(tokens.id_token) : null;
	return {
		source: "codex",
		providerIds: ["openai", "openai-codex"],
		...plan(claims?.["https://api.openai.com/auth"]?.chatgpt_plan_type),
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
		readJson(join(dir, "apps.json"), Dictionary),
		readJson(join(dir, "hosts.json"), Dictionary),
	]);
	const signedIn = files.some(
		(file) =>
			file !== null && Object.values(file).some((entry) => Check(CopilotEditorEntrySchema, entry)),
	);
	return signedIn ? { source: "github-copilot", providerIds: ["github-copilot"] } : null;
}

async function detectCopilotCli(
	env: NodeJS.ProcessEnv,
	home: string,
): Promise<AccountSignal | null> {
	const config = await readJson(
		join(envPath(env, "COPILOT_HOME") ?? join(home, ".copilot"), "config.json"),
		CopilotCliConfigSchema,
	);
	const signedIn = config?.loggedInUsers.some((user) => Check(CopilotCliUserSchema, user)) ?? false;
	return signedIn ? { source: "copilot-cli", providerIds: ["github-copilot"] } : null;
}

async function detectKimiCli(env: NodeJS.ProcessEnv, home: string): Promise<AccountSignal | null> {
	const share = envPath(env, "KIMI_SHARE_DIR") ?? join(home, ".kimi");
	const token = await readJson(join(share, "credentials", "kimi-code.json"), KimiCredentialsSchema);
	return token ? { source: "kimi-cli", providerIds: ["kimi-coding"] } : null;
}

async function detectGrokBuild(
	env: NodeJS.ProcessEnv,
	home: string,
	now: number,
): Promise<AccountSignal | null> {
	const path =
		envPath(env, "GROK_AUTH_PATH") ??
		join(envPath(env, "GROK_HOME") ?? join(home, ".grok"), "auth.json");
	const auth = await readJson(path, Dictionary);
	if (!auth) return null;
	const signedIn = Object.entries(auth).some(
		([scope, entry]) =>
			scope !== GROK_API_KEY_SCOPE &&
			Check(GrokEntrySchema, entry) &&
			entry.auth_mode !== "api_key" &&
			(Check(Filled, entry.refresh_token) || expiresAfter(entry.expires_at, now)),
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
