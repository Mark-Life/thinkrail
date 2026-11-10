import { compile, int, obj } from "@earendil-works/pi-schema";

const REPO_API_URL = "https://api.github.com/repos/JetBrains/thinkrail";
const STARS_TIMEOUT_MS = 2_000;

const RepoReply = compile(
	obj({ stargazers_count: int({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) }, { open: true }),
);

let fetchOverride: typeof fetch | null = null;

export function setGithubStarsFetchForTests(next: typeof fetch | null): void {
	fetchOverride = next;
}

export async function fetchGithubStars(): Promise<number | null> {
	try {
		const response = await (fetchOverride ?? fetch)(REPO_API_URL, {
			headers: { Accept: "application/vnd.github+json" },
			signal: AbortSignal.timeout(STARS_TIMEOUT_MS),
		});
		if (!response.ok) return null;
		const body: unknown = await response.json();
		return RepoReply.check(body) ? body.stargazers_count : null;
	} catch {
		return null;
	}
}
