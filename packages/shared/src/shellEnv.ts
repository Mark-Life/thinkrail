const USER_PATH_MARKERS = ["/.nvm/", "/homebrew/", "/usr/local/bin", "/.bun/"];
const PROBE_TIMEOUT_MS = 5000;
const LAUNCHCTL_TIMEOUT_MS = 3000;
const ORPHAN_PIPE_GRACE_MS = 100;

type ShellEnv = Record<string, string | undefined>;

export function pathLooksComplete(path: string): boolean {
	return USER_PATH_MARKERS.some((marker) => path.includes(marker));
}

async function readStdout(argv: string[], timeout: number): Promise<string | null> {
	try {
		const child = Bun.spawn(argv, { timeout, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
		const reader = child.stdout.getReader();
		const decoder = new TextDecoder();
		let text = "";
		const drained = (async () => {
			for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
				text += decoder.decode(chunk.value, { stream: true });
			}
		})().catch(() => {});
		const code = await child.exited;
		await Promise.race([drained, Bun.sleep(ORPHAN_PIPE_GRACE_MS)]);
		void reader.cancel().catch(() => {});
		return code === 0 ? text + decoder.decode() : null;
	} catch {
		return null;
	}
}

async function probeLoginShellPath(shell: string, interactive: boolean): Promise<string | null> {
	const args = interactive ? ["-l", "-i", "-c", "env -0"] : ["-l", "-c", "env -0"];
	const text = await readStdout([shell, ...args], PROBE_TIMEOUT_MS);
	if (text === null) return null;
	for (const entry of text.split("\0")) {
		const eq = entry.indexOf("=");
		if (eq !== -1 && entry.slice(0, eq) === "PATH") return entry.slice(eq + 1);
	}
	return null;
}

export function localeRepair(env: ShellEnv, platform: string): string | null {
	if (env.LC_ALL || env.LC_CTYPE || env.LANG) return null;
	return platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
}

async function resolvePath(env: ShellEnv): Promise<void> {
	if (pathLooksComplete(env.PATH ?? "")) return;

	const shell = env.SHELL ?? "/bin/zsh";
	const path =
		(await probeLoginShellPath(shell, true)) ?? (await probeLoginShellPath(shell, false));
	if (path) env.PATH = path;
}

async function resolveSshAgentSock(env: ShellEnv, platform: string): Promise<void> {
	if (env.SSH_AUTH_SOCK || platform !== "darwin") return;
	const text = await readStdout(["launchctl", "getenv", "SSH_AUTH_SOCK"], LAUNCHCTL_TIMEOUT_MS);
	const sock = text?.trim();
	if (sock) env.SSH_AUTH_SOCK = sock;
}

export async function repairShellEnv(
	env: ShellEnv = process.env,
	platform: string = process.platform,
): Promise<void> {
	if (platform === "win32") return;
	const lang = localeRepair(env, platform);
	if (lang) env.LANG = lang;
	await Promise.all([resolvePath(env), resolveSshAgentSock(env, platform)]);
}

const pendingKey = Symbol.for("thinkrail.shellEnv.pending");
const processState = globalThis as typeof globalThis & { [pendingKey]?: Promise<void> };

export function resolveShellEnv(): Promise<void> {
	processState[pendingKey] ??= repairShellEnv();
	return processState[pendingKey];
}
