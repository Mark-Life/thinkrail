import {
	closeSearchPanel,
	findNext,
	findPrevious,
	openSearchPanel,
	search,
	setSearchQuery,
} from "@codemirror/search";
import { type EditorView, keymap, type Panel } from "@codemirror/view";
import { portalHost } from "./decorations";

export const FIND_FIELD = "main-field";

function findPanel(view: EditorView): Panel {
	const dom = document.createElement("div");
	const host = view.state.facet(portalHost);
	return {
		dom,
		top: true,
		mount: () => host?.mount(dom, { kind: "find" }),
		update(update) {
			const field = dom.querySelector<HTMLInputElement>(`[${FIND_FIELD}]`);
			for (const tr of update.transactions) {
				for (const effect of tr.effects) {
					if (effect.is(setSearchQuery) && field && field.value !== effect.value.search) {
						field.value = effect.value.search;
					}
				}
			}
		},
		destroy: () => host?.unmount(dom),
	};
}

const scope = "editor search-panel";

export const liveFind = [
	search({ top: true, createPanel: findPanel }),
	keymap.of([
		{ key: "Mod-f", run: openSearchPanel, scope, preventDefault: true },
		{ key: "Mod-g", run: findNext, shift: findPrevious, scope, preventDefault: true },
		{ key: "F3", run: findNext, shift: findPrevious, scope, preventDefault: true },
		{ key: "Escape", run: closeSearchPanel, scope },
	]),
];
