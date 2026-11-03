import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SymbolId } from "../core/types";
import { Header } from "./components/Header";
import { Palette } from "./components/Palette";
import { ErrorState, LoadingState } from "./components/States";
import { TrustFooter } from "./components/TrustFooter";
import { describeLoadError, type LoadProgress, loadData } from "./lib/api";
import { isTypingTarget, useRoute } from "./lib/hooks";
import { CHANGES_HREF, flowHref, MAP_HREF, type Route, traceHref } from "./lib/route";
import {
	buildWorkspace,
	sideOfSymbol,
	useWorkspace,
	type Workspace,
	WorkspaceProvider,
} from "./lib/workspace";
import { ChangesView } from "./views/ChangesView";
import { FileView } from "./views/FileView";
import { FlowView } from "./views/FlowView";
import { MapView } from "./views/MapView";
import { SymbolView } from "./views/SymbolView";
import { TraceView } from "./views/TraceView";

type LoadState =
	| { status: "loading"; progress?: LoadProgress }
	| { status: "error"; error: unknown }
	| { status: "ready"; workspace: Workspace };

function currentSymbol(route: Route) {
	if (route.view === "symbol" || route.view === "trace" || route.view === "flow")
		return route.symbol;
	if (route.view === "changes") return route.symbol;
	return undefined;
}

function routeBody(route: Route) {
	switch (route.view) {
		case "map":
			return <MapView route={route} />;
		case "trace":
			return <TraceView route={route} />;
		case "flow":
			return <FlowView route={route} />;
		case "symbol":
			return <SymbolView route={route} />;
		case "file":
			return <FileView route={route} />;
		case "changes":
			return <ChangesView route={route} />;
	}
}

function Shell() {
	const workspace = useWorkspace();
	const fallback = useMemo<Route>(
		() =>
			workspace.session.mode === "diff"
				? { view: "changes", section: "groups", tab: "calls" }
				: { view: "map", tests: false },
		[workspace.session.mode],
	);
	const route = useRoute(fallback);
	const [paletteOpen, setPaletteOpen] = useState(false);
	const lastSymbol = useRef<SymbolId | undefined>(undefined);
	lastSymbol.current = currentSymbol(route) ?? lastSymbol.current;

	const switchView = useCallback(
		(view: "map" | "trace" | "flow" | "changes") => {
			const symbol = lastSymbol.current;
			const side = sideOfSymbol(workspace, symbol);
			if (view === "map") window.location.hash = MAP_HREF;
			else if (view === "trace") window.location.hash = traceHref(symbol, side);
			else if (view === "flow") window.location.hash = flowHref(symbol, side);
			else if (workspace.diff) window.location.hash = CHANGES_HREF;
		},
		[workspace],
	);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
				event.preventDefault();
				setPaletteOpen(true);
				return;
			}
			if (event.repeat) return;
			if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
			if (event.key === "/") {
				event.preventDefault();
				setPaletteOpen(true);
			} else if (event.key === "t") switchView("trace");
			else if (event.key === "f") switchView("flow");
			else if (event.key === "m") switchView("map");
			else if (event.key === "c") switchView("changes");
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [switchView]);

	return (
		<div className="shell">
			<Header
				route={route}
				lastSymbol={lastSymbol.current}
				onOpenPalette={() => setPaletteOpen(true)}
			/>
			<main className="shell-main">{routeBody(route)}</main>
			<TrustFooter />
			{paletteOpen ? <Palette onClose={() => setPaletteOpen(false)} /> : null}
		</div>
	);
}

export function App() {
	const [state, setState] = useState<LoadState>({ status: "loading" });
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		const controller = new AbortController();
		const { signal } = controller;
		setState({ status: "loading" });
		void attempt;
		loadData({
			signal,
			onProgress: (progress) => {
				if (!signal.aborted) setState({ status: "loading", progress });
			},
		})
			.then((data) => {
				if (!signal.aborted) setState({ status: "ready", workspace: buildWorkspace(data) });
			})
			.catch((error: unknown) => {
				if (!signal.aborted) setState({ status: "error", error });
			});
		return () => controller.abort();
	}, [attempt]);

	if (state.status === "loading") return <LoadingState progress={state.progress} />;
	if (state.status === "error") {
		const described = describeLoadError(state.error);
		return (
			<ErrorState
				title={described.title}
				detail={described.detail}
				onRetry={() => setAttempt((value) => value + 1)}
			/>
		);
	}
	return (
		<WorkspaceProvider value={state.workspace}>
			<Shell />
		</WorkspaceProvider>
	);
}
