import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { defaultSessionDirFor, writeFixtureSession } from "@thinkrail/server/history-test-fixtures";
import { removeTree } from "@thinkrail/shared/removeTree";
import { toolHomeEnv } from "@thinkrail/shared/toolHomes";
import { type Static, type TSchema, Type } from "typebox";
import { Check } from "typebox/value";
import { within } from "./lifecycle";

export interface ArtifactResources {
	readonly skillsDir: string;
	readonly trashHelpers: {
		readonly macos: string;
		readonly windows: string;
	};
}

export interface RunningArtifactHost {
	readonly origin: string;
	readonly resources: ArtifactResources;
	stop(): Promise<void>;
}

export interface ArtifactHostAdapter {
	readonly name: string;
	launch(env: Record<string, string>, label: string): Promise<RunningArtifactHost>;
}

const Ack = Type.Unknown();
const RpcFrameSchema = Type.Object({
	id: Type.Optional(Type.String()),
	ok: Type.Optional(Type.Boolean()),
	result: Type.Optional(Type.Unknown()),
	error: Type.Optional(Type.String()),
});
const McpListSchema = Type.Object({
	statuses: Type.Optional(
		Type.Array(
			Type.Object({
				sessionId: Type.String(),
				servers: Type.Array(
					Type.Object({
						name: Type.String(),
						state: Type.String(),
						toolCount: Type.Optional(Type.Number()),
					}),
				),
			}),
		),
	),
});
const ModelListSchema = Type.Array(
	Type.Object({
		provider: Type.Optional(Type.String()),
		id: Type.Optional(Type.String()),
		name: Type.Optional(Type.String()),
	}),
);
const ProviderStatusSchema = Type.Object({
	jbcentral: Type.Optional(Type.Object({ state: Type.Optional(Type.String()) })),
});
const SessionStateListSchema = Type.Array(
	Type.Object({
		sessionId: Type.String(),
		state: Type.Object({
			execution: Type.String(),
			completion: Type.Unknown(),
			needsInput: Type.Optional(Type.Union([Type.Object({ kind: Type.String() }), Type.Null()])),
		}),
	}),
);
const TranscriptSchema = Type.Object({
	messages: Type.Array(
		Type.Object({
			role: Type.String(),
			toolName: Type.Optional(Type.String()),
			toolCallId: Type.Optional(Type.String()),
			isError: Type.Optional(Type.Boolean()),
			content: Type.Optional(
				Type.Union([
					Type.String(),
					Type.Array(Type.Object({ text: Type.Optional(Type.String()) })),
				]),
			),
			details: Type.Optional(Type.Unknown()),
		}),
	),
});
const LoginPushSchema = Type.Object({
	channel: Type.Optional(Type.String()),
	data: Type.Optional(
		Type.Object({
			loginId: Type.Optional(Type.String()),
			frame: Type.Optional(
				Type.Object({
					kind: Type.String(),
					url: Type.Optional(Type.String()),
					message: Type.Optional(Type.String()),
					options: Type.Optional(
						Type.Array(Type.Object({ id: Type.String(), label: Type.String() })),
					),
				}),
			),
		}),
	),
});
const LoginStartSchema = Type.Object({ loginId: Type.Optional(Type.String()) });
const ProjectSchema = Type.Object({ id: Type.Optional(Type.String()) });
const WorkspaceListSchema = Type.Array(
	Type.Object({
		id: Type.Optional(Type.String()),
		kind: Type.Optional(Type.String()),
		worktreePath: Type.Optional(Type.String()),
	}),
);
const SkillListSchema = Type.Array(
	Type.Object({
		name: Type.Optional(Type.String()),
		description: Type.Optional(Type.String()),
		sourceInfo: Type.Optional(Type.Object({ scope: Type.Optional(Type.String()) })),
	}),
);
const CommandListSchema = Type.Array(Type.Object({ name: Type.Optional(Type.String()) }));
const CreatedSessionSchema = Type.Object({ sessionId: Type.Optional(Type.String()) });

const MALFORMED_MERMAID = "flowchart LR\n A -->";
const ASK_PROMPT = "Ask the runtime question.";
const ASK_TOOL_CALL_ID = "artifact-ask";
const ASK_QUESTION = {
	questions: [
		{
			question: "Which runtime?",
			header: "Runtime",
			options: [
				{ label: "Bun", description: "fast" },
				{ label: "Node", description: "compatible" },
			],
		},
	],
};
const ASK_ANSWER = {
	cancelled: false,
	answers: [{ questionIndex: 0, question: "Which runtime?", kind: "option", answer: "Bun" }],
};

const MCP_STDIO_FIXTURE = `import { createInterface } from "node:readline";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize")
    return reply(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "artifact-smoke", version: "1.0.0" },
    });
  if (message.method === "tools/list")
    return reply(message.id, {
      tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: {} } }],
    });
  return reply(message.id, { content: [{ type: "text", text: "ok" }] });
});
`;

function startNeedsSignInServer(): { url: string; stop: () => void } {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const { pathname, origin } = new URL(request.url);
			if (pathname.startsWith("/.well-known/oauth-protected-resource")) {
				return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
			}
			if (pathname === "/.well-known/oauth-authorization-server") {
				return Response.json({
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					registration_endpoint: `${origin}/register`,
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
				});
			}
			return new Response("unauthorized", {
				status: 401,
				headers: {
					"WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
				},
			});
		},
	});
	return { url: `http://127.0.0.1:${server.port}/mcp`, stop: () => server.stop(true) };
}

function writeMcpFixtures(root: string, agentDir: string, httpUrl: string): void {
	const fixture = join(root, "mcp-stdio-fixture.mjs");
	writeFileSync(fixture, MCP_STDIO_FIXTURE);
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				"smoke-stdio": { command: process.execPath, args: [fixture], exposure: "direct" },
				"smoke-oauth": { url: httpUrl, exposure: "direct" },
			},
		}),
	);
}

async function assertMcpServersReported(
	socket: WebSocket,
	workspaceId: string,
	sessionId: string,
): Promise<void> {
	const until = Date.now() + 30_000;
	for (;;) {
		const listed = await within(
			rpc(socket, "mcp.list", { workspaceId }, McpListSchema),
			10_000,
			"mcp.list",
		);
		const servers = listed.statuses?.find((snapshot) => snapshot.sessionId === sessionId)?.servers;
		const stdio = servers?.find((server) => server.name === "smoke-stdio");
		const http = servers?.find((server) => server.name === "smoke-oauth");
		if (stdio?.state === "connected" && stdio.toolCount === 1 && http?.state === "needs-sign-in")
			return;
		if (Date.now() > until) {
			throw new Error(`the MCP engine did not report both fixtures: ${JSON.stringify(servers)}`);
		}
		await Bun.sleep(250);
	}
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function connectRpc(baseUrl: string): Promise<WebSocket> {
	const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws`);
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), {
			once: true,
		});
	});
	return socket;
}

let requestSequence = 0;
function rpc<S extends TSchema>(
	socket: WebSocket,
	method: string,
	params: object,
	schema: S,
): Promise<Static<S>> {
	const id = `artifact_${++requestSequence}`;
	return new Promise((resolve, reject) => {
		const onMessage = (event: MessageEvent) => {
			if (typeof event.data !== "string") return;
			const frame: unknown = JSON.parse(event.data);
			if (!Check(RpcFrameSchema, frame) || frame.id !== id) return;
			socket.removeEventListener("message", onMessage);
			if (!frame.ok) reject(new Error(frame.error ?? `${method} failed`));
			else if (Check(schema, frame.result)) resolve(frame.result);
			else reject(new Error(`${method} returned an unexpected shape`));
		};
		socket.addEventListener("message", onMessage);
		socket.send(JSON.stringify({ id, method, params }));
	});
}

function findExternalModel(models: Static<typeof ModelListSchema>) {
	const model = models.find(
		(entry) =>
			entry.provider === "compiled-external" &&
			entry.id === "compiled-external-model" &&
			entry.name === "Compiled external extension model (.pi)",
	);
	assert(model, "global external extension model (value-importing pi) is missing");
	return model;
}

async function assertCentralConfigured(socket: WebSocket, label: string): Promise<void> {
	let state: string | undefined;
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const status = await within(
			rpc(socket, "provider.status", {}, ProviderStatusSchema),
			10_000,
			`${label} status`,
		);
		state = status.jbcentral?.state;
		if (state === "configured") return;
		if (state !== "configuring") break;
		await Bun.sleep(250);
	}
	throw new Error(`${label} Central state is ${JSON.stringify(state)}, expected configured`);
}

async function assertStrictVisualizeValidation(
	socket: WebSocket,
	workspaceId: string,
	sessionId: string,
): Promise<void> {
	await within(
		rpc(socket, "session.prompt", { sessionId, text: "Draw the broken flowchart." }, Ack),
		10_000,
		"session.prompt",
	);
	for (let attempt = 0; attempt < 240; attempt += 1) {
		const states = await within(
			rpc(socket, "session.stateList", {}, SessionStateListSchema),
			10_000,
			"session.stateList",
		);
		const state = states.find((entry) => entry.sessionId === sessionId)?.state;
		if (state?.execution === "idle" && state.completion !== null) break;
		await Bun.sleep(250);
	}
	const transcript = await within(
		rpc(socket, "session.getMessages", { sessionId, workspaceId }, TranscriptSchema),
		10_000,
		"session.getMessages",
	);
	const result = transcript.messages.find(
		(message) => message.role === "toolResult" && message.toolName === "visualize",
	);
	assert(result, "the scripted visualize tool call never executed in the artifact session");
	assert(result.isError === true, "strict mermaid validation accepted a dangling flowchart edge");
	const text = Array.isArray(result.content)
		? result.content.map((block) => block.text ?? "").join("\n")
		: "";
	assert(
		/invalid Mermaid syntax in `mermaid`/.test(text) && /Parse error/.test(text),
		`visualize rejected the diagram without the strict mermaid parse error: ${text}`,
	);
}

async function sessionState(socket: WebSocket, sessionId: string) {
	const states = await within(
		rpc(socket, "session.stateList", {}, SessionStateListSchema),
		10_000,
		"session.stateList",
	);
	const state = states.find((entry) => entry.sessionId === sessionId)?.state;
	assert(state, `session ${sessionId} is missing from session.stateList`);
	return state;
}

async function assertAskUserQuestionRoundTrip(
	socket: WebSocket,
	workspaceId: string,
	sessionId: string,
): Promise<void> {
	const prompting = rpc(socket, "session.prompt", { sessionId, text: ASK_PROMPT }, Ack);
	prompting.catch(() => {});
	let asked = false;
	for (let attempt = 0; attempt < 240 && !asked; attempt += 1) {
		asked = (await sessionState(socket, sessionId)).needsInput?.kind === "tool-response";
		if (!asked) await Bun.sleep(250);
	}
	assert(asked, "the scripted ask_user_question call never blocked the artifact session");
	await within(
		rpc(
			socket,
			"session.respondToTool",
			{
				sessionId,
				toolCallId: ASK_TOOL_CALL_ID,
				response: ASK_ANSWER,
			},
			Ack,
		),
		10_000,
		"session.respondToTool",
	);
	await within(prompting, 30_000, "session.prompt acknowledgement");
	for (let attempt = 0; attempt < 240; attempt += 1) {
		const state = await sessionState(socket, sessionId);
		if (state.execution === "idle" && state.completion !== null) break;
		await Bun.sleep(250);
	}
	const transcript = await within(
		rpc(socket, "session.getMessages", { sessionId, workspaceId }, TranscriptSchema),
		10_000,
		"session.getMessages",
	);
	const result = transcript.messages.find(
		(message) => message.role === "toolResult" && message.toolCallId === ASK_TOOL_CALL_ID,
	);
	assert(result, "the answered ask_user_question call left no tool result in the transcript");
	assert(result.isError !== true, "the answered ask_user_question call persisted as an error");
	assert(
		JSON.stringify(result.details) === JSON.stringify(ASK_ANSWER),
		`the persisted answer differs from the one sent: ${JSON.stringify(result.details)}`,
	);
}

async function assertOAuthLoginReachesAuthUrl(socket: WebSocket): Promise<void> {
	let loginId: string | undefined;
	const authUrl = new Promise<string>((resolve, reject) => {
		const settle = (fn: () => void) => {
			socket.removeEventListener("message", onPush);
			fn();
		};
		const onPush = (event: MessageEvent) => {
			if (typeof event.data !== "string") return;
			const message: unknown = JSON.parse(event.data);
			if (!Check(LoginPushSchema, message)) return;
			if (message.channel !== "provider.login" || !message.data?.frame) return;
			const { loginId: pushLoginId, frame } = message.data;
			if (frame.kind === "select") {
				const browser = frame.options?.find((option) =>
					/browser/i.test(`${option.id} ${option.label}`),
				);
				const optionId = browser?.id ?? frame.options?.[0]?.id;
				if (!optionId || !pushLoginId) {
					settle(() => reject(new Error(`unanswerable select frame: ${JSON.stringify(frame)}`)));
					return;
				}
				rpc(socket, "provider.loginReply", { loginId: pushLoginId, value: optionId }, Ack).catch(
					(error) =>
						settle(() => reject(error instanceof Error ? error : new Error(String(error)))),
				);
				return;
			}
			if (frame.kind === "authUrl") settle(() => resolve(frame.url ?? ""));
			if (frame.kind === "error") {
				settle(() => reject(new Error(`login flow failed: ${frame.message}`)));
			}
		};
		socket.addEventListener("message", onPush);
		rpc(socket, "provider.loginStart", { providerId: "openai-codex" }, LoginStartSchema).then(
			(result) => {
				loginId = result.loginId;
			},
			(error) => settle(() => reject(error instanceof Error ? error : new Error(String(error)))),
		);
	});
	try {
		const reached = await within(authUrl, 30_000, "Codex OAuth auth URL");
		assert(reached.includes("auth.openai.com"), `unexpected auth URL: ${reached}`);
	} finally {
		if (loginId !== undefined)
			rpc(socket, "provider.loginCancel", { loginId }, Ack).catch(() => {});
	}
}

export function hostEnvironment(
	overrides: Record<string, string>,
	unset: string[] = [],
	env: Record<string, string | undefined> = process.env,
): Record<string, string> {
	const shadowed = new Set([...Object.keys(overrides), ...unset].map((name) => name.toLowerCase()));
	const inherited: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) {
		if (value !== undefined && !shadowed.has(name.toLowerCase())) inherited[name] = value;
	}
	return { ...inherited, ...overrides };
}

function createCentralExecutable(fakeBinDir: string): void {
	if (process.platform !== "win32") {
		writeFileSync(
			join(fakeBinDir, "central"),
			'#!/bin/sh\n[ "$1" = "--version" ] || exit 8\nprintf \'central 1.6.2 (synthetic artifact metadata)\\n\'\n',
			{ mode: 0o755 },
		);
		return;
	}
	const source = join(fakeBinDir, "central.ts");
	writeFileSync(
		source,
		'if (process.argv[2] !== "--version") process.exit(8); console.log("central 1.6.2 (synthetic artifact metadata)");\n',
	);
	const build = Bun.spawnSync([
		process.execPath,
		"build",
		"--compile",
		source,
		"--outfile",
		join(fakeBinDir, "central.exe"),
	]);
	assert(build.success, `could not build the synthetic Central executable: ${build.stderr}`);
}

export async function runArtifactHostProbes(adapter: ArtifactHostAdapter): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), `thinkrail-${adapter.name}-artifact-`));
	const homeDir = join(root, "home");
	const fakeBinDir = join(root, "no-pi-bin");
	const projectDir = join(root, "project");
	const agentDir = join(root, "pi-agent");
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(fakeBinDir, { recursive: true });
	createCentralExecutable(fakeBinDir);
	const centralArtifact = join(homeDir, ".pi", "agent", "extensions", "jetbrains-central.ts");
	mkdirSync(dirname(centralArtifact), { recursive: true });
	writeFileSync(
		centralArtifact,
		`import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel } from "@earendil-works/pi-ai/models";
const api = "compiled-external-faux";
const model = {
  id: "compiled-external-model",
  name: \`Compiled external extension model (\${CONFIG_DIR_NAME})\`,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 4096,
  api,
};
if (clampThinkingLevel(model, "high") !== "off") throw new Error("pi-ai/models alias failed");
const faux = createFauxCore({ api, provider: "compiled-external", models: [model] });
const respond = (context) => {
  faux.appendResponses([respond]);
  const last = context.messages[context.messages.length - 1];
  if (last && last.role === "toolResult") return fauxAssistantMessage("Tool call attempted.");
  if (last && last.role === "user" && JSON.stringify(last.content).includes(${JSON.stringify(ASK_PROMPT)}))
    return fauxAssistantMessage(
      [fauxToolCall("ask_user_question", ${JSON.stringify(ASK_QUESTION)}, { id: ${JSON.stringify(ASK_TOOL_CALL_ID)} })],
      { stopReason: "toolUse" },
    );
  return fauxAssistantMessage(
    [fauxToolCall("visualize", { type: "diagram", mermaid: ${JSON.stringify(MALFORMED_MERMAID)} })],
    { stopReason: "toolUse" },
  );
};
faux.setResponses([respond]);
export default function syntheticExternalExtension(pi) {
  pi.registerProvider("compiled-external", {
    api,
    baseUrl: "https://compiled-extension.invalid",
    apiKey: "synthetic-smoke-key",
    models: [model],
    streamSimple: faux.streamSimple,
  });
}
`,
	);
	const inheritedPath = (process.env.PATH ?? "")
		.split(delimiter)
		.filter((directory) => directory && !Bun.which("pi", { PATH: directory }));
	const noPiPath = [fakeBinDir, ...inheritedPath].join(delimiter);
	assert(!Bun.which("pi", { PATH: noPiPath }), "probe PATH unexpectedly contains pi");
	assert(Bun.which("git", { PATH: noPiPath }), "probe PATH does not contain git");

	const skillDir = join(projectDir, ".claude", "skills", "compiled-portable");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		"---\nname: compiled-portable\ndescription: Compiled portable smoke skill\n---\n\n# Smoke\n",
	);
	for (const command of [
		["git", "-C", projectDir, "init", "-b", "main"],
		["git", "-C", projectDir, "add", "."],
		[
			"git",
			"-C",
			projectDir,
			"-c",
			"user.name=ThinkRail Smoke",
			"-c",
			"user.email=smoke@thinkrail.invalid",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"--quiet",
			"-m",
			"seed artifact project",
		],
	]) {
		assert(Bun.spawnSync(command).success, `fixture command failed: ${command.join(" ")}`);
	}

	const baseEnv: Record<string, string> = {
		PI_OFFLINE: "1",
		...toolHomeEnv(homeDir),
		PATH: noPiPath,
		THINKRAIL_NO_ANALYTICS: "1",
		CI: "1",
	};
	let defaultHost: RunningArtifactHost | undefined;
	let customHost: RunningArtifactHost | undefined;
	let socket: WebSocket | undefined;
	const needsSignIn = startNeedsSignInServer();
	try {
		const defaultEnv = hostEnvironment(
			{
				...baseEnv,
				THINKRAIL_DATA_DIR: join(root, "default-data"),
				XDG_CACHE_HOME: join(root, "default-cache"),
			},
			["PI_CODING_AGENT_DIR"],
		);
		defaultHost = await adapter.launch(defaultEnv, "default-agent");
		socket = await within(connectRpc(defaultHost.origin), 10_000, "default host WebSocket");
		findExternalModel(
			await within(rpc(socket, "model.list", {}, ModelListSchema), 20_000, "default model.list"),
		);
		await assertCentralConfigured(socket, "default-agent");
		socket.close();
		socket = undefined;
		await defaultHost.stop();
		defaultHost = undefined;

		const customEnv = hostEnvironment({
			...baseEnv,
			THINKRAIL_DATA_DIR: join(root, "data"),
			PI_CODING_AGENT_DIR: agentDir,
			XDG_CACHE_HOME: join(root, "cache"),
		});
		customHost = await adapter.launch(customEnv, "custom-agent");
		const health = await within(fetch(`${customHost.origin}/health`), 10_000, "GET /health");
		assert(health.ok && (await health.text()) === "ok", `/health answered ${health.status}`);
		const index = await within(fetch(customHost.origin), 10_000, "GET /");
		assert(index.ok && (await index.text()).includes("ThinkRail"), "web UI was not served");
		socket = await within(connectRpc(customHost.origin), 10_000, "custom host WebSocket");
		const models = await within(
			rpc(socket, "model.list", {}, ModelListSchema),
			20_000,
			"custom model.list",
		);
		const externalModel = findExternalModel(models);
		await assertCentralConfigured(socket, "custom-agent");

		const project = await within(
			rpc(socket, "project.open", { path: projectDir }, ProjectSchema),
			10_000,
			"project.open",
		);
		assert(project.id, "project.open returned no project id");
		const workspaces = await within(
			rpc(socket, "workspace.list", { projectId: project.id }, WorkspaceListSchema),
			10_000,
			"workspace.list",
		);
		const workspace = workspaces.find((entry) => entry.kind === "default");
		assert(workspace?.id && workspace.worktreePath, "Default workspace is missing");
		const transcript = writeFixtureSession(defaultSessionDirFor(agentDir, workspace.worktreePath), {
			cwd: resolve(workspace.worktreePath),
			name: "artifact trash probe",
			messages: [{ role: "user", text: "move to trash", timestamp: Date.now() }],
		});
		await within(
			rpc(socket, "session.delete", { sessionId: transcript.id, workspaceId: workspace.id }, Ack),
			10_000,
			"session.delete",
		);
		assert(!existsSync(transcript.path), "session.delete left the transcript on disk");
		await within(
			rpc(socket, "project.setTrust", { id: project.id, trusted: true }, Ack),
			10_000,
			"trust",
		);
		const skills = await within(
			rpc(socket, "skill.list", { projectId: project.id }, SkillListSchema),
			30_000,
			"skill.list",
		);
		const portable = skills.find((entry) => entry.name === "skill:compiled-portable");
		assert(portable?.description === "Compiled portable smoke skill", "portable skill is missing");
		assert(portable.sourceInfo?.scope === "project", "portable skill provenance is wrong");
		assert(
			skills.some((entry) => entry.name === "skill:brainstorming"),
			"bundled workflow skill is missing",
		);
		writeMcpFixtures(root, agentDir, needsSignIn.url);
		const created = await within(
			rpc(
				socket,
				"session.create",
				{ workspaceId: workspace.id, model: externalModel },
				CreatedSessionSchema,
			),
			30_000,
			"session.create with bundled factories",
		);
		assert(created.sessionId, "session.create returned no session id");
		await assertMcpServersReported(socket, workspace.id, created.sessionId);
		const commands = await within(
			rpc(socket, "session.getCommands", { sessionId: created.sessionId }, CommandListSchema),
			10_000,
			"session.getCommands",
		);
		assert(
			commands.some((entry) => entry.name === "skill:brainstorming"),
			"session resource loader omitted bundled skills",
		);
		await assertStrictVisualizeValidation(socket, workspace.id, created.sessionId);
		await assertAskUserQuestionRoundTrip(socket, workspace.id, created.sessionId);
		await within(
			rpc(socket, "session.dispose", { sessionId: created.sessionId }, Ack),
			10_000,
			"session.dispose",
		);
		await assertOAuthLoginReachesAuthUrl(socket);

		for (const helper of Object.values(customHost.resources.trashHelpers)) {
			assert(existsSync(helper), `trash helper is missing: ${helper}`);
		}
		for (const skill of [
			"spec-graph",
			"asking-user-questions",
			"brainstorming",
			"choosing-a-workflow",
			"importing-a-codebase",
			"setting-up-a-project",
			"starting-a-new-project",
			"writing-specs",
			"writing-workflow-skills",
		]) {
			assert(
				existsSync(join(customHost.resources.skillsDir, "host", skill, "SKILL.md")),
				`skill file missing: ${skill}`,
			);
		}
		assert(
			existsSync(join(customHost.resources.skillsDir, "host", "SPEC.md")),
			"workflow SPEC is missing",
		);
		assert(
			existsSync(
				join(customHost.resources.skillsDir, "extensions", "web-access", "librarian", "SKILL.md"),
			),
			"web-access's librarian skill is not staged under its owner folder",
		);
		socket.close();
		socket = undefined;
		await customHost.stop();
		customHost = undefined;
	} finally {
		socket?.close();
		await defaultHost?.stop().catch(() => {});
		await customHost?.stop().catch(() => {});
		needsSignIn.stop();
		removeTree(root);
	}
}
