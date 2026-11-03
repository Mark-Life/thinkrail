import type { ReactNode } from "react";
import type { LoadProgress } from "../lib/api";
import { formatBytes } from "../lib/format";

export function LoadingState(props: { progress?: LoadProgress | undefined }) {
	const { progress } = props;
	const fraction = progress && progress.total > 0 ? progress.loaded / progress.total : undefined;
	return (
		<div className="state-screen" role="status">
			<div className="state-box">
				<h1 className="state-title">repo-map</h1>
				<p className="state-text">
					{progress ? `Loading ${progress.label.toLowerCase()}` : "Connecting"}
				</p>
				<div className={fraction === undefined ? "progress progress-idle" : "progress"}>
					<div
						className="progress-bar"
						style={{ width: fraction === undefined ? undefined : `${Math.round(fraction * 100)}%` }}
					/>
				</div>
				<p className="state-hint">
					{progress
						? `${formatBytes(progress.loaded)}${progress.total > 0 ? ` of ${formatBytes(progress.total)}` : ""}`
						: " "}
				</p>
			</div>
		</div>
	);
}

export function ErrorState(props: { title: string; detail: string; onRetry: () => void }) {
	return (
		<div className="state-screen" role="alert">
			<div className="state-box">
				<h1 className="state-title">{props.title}</h1>
				<p className="state-text">{props.detail}</p>
				<button type="button" className="button button-primary" onClick={props.onRetry}>
					Retry
				</button>
			</div>
		</div>
	);
}

export function InlineMessage(props: { title: string; children?: ReactNode; tone?: "error" }) {
	return (
		<div className={props.tone === "error" ? "inline-message inline-error" : "inline-message"}>
			<p className="inline-title">{props.title}</p>
			{props.children ? <div className="inline-body">{props.children}</div> : null}
		</div>
	);
}
