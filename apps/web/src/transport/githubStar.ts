import type { GithubStarAsk } from "@thinkrail/contracts";
import { t } from "@thinkrail/locales/react";
import { REPO_URL } from "../constants/branding";
import type { Toast } from "../store";

const GITHUB_STAR_ASK_MS = 60_000;

export function formatStarCount(count: number): string {
	return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

function starsOf({ stars }: GithubStarAsk): number | null {
	return stars !== null && Number.isSafeInteger(stars) && stars >= 0 ? stars : null;
}

export function githubStarToast(ask: GithubStarAsk): Omit<Toast, "id"> {
	const stars = starsOf(ask);
	return {
		variant: "info",
		title: t("app.githubStar.title"),
		message: t("app.githubStar.message"),
		durationMs: GITHUB_STAR_ASK_MS,
		action: {
			label:
				stars === null
					? t("app.githubStar.action")
					: t("app.githubStar.actionStars", { stars: formatStarCount(stars) }),
			onClick: () => window.open(REPO_URL, "_blank", "noopener,noreferrer"),
		},
	};
}
