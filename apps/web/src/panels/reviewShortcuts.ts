import { hasLayer, isTextEntryTarget, layoutResourceIdentity, MODAL_LAYER_SELECTOR } from "@/lib";
import { type ChangesTab, selectAttentionCenterTab, useAppStore } from "../store";

export function ownsReviewShortcut(
	event: Pick<KeyboardEvent, "defaultPrevented"> & { readonly target: unknown },
	tab: ChangesTab,
	doc: Parameters<typeof hasLayer>[0] = document,
): boolean {
	if (
		event.defaultPrevented ||
		isTextEntryTarget(event.target) ||
		hasLayer(doc, `${MODAL_LAYER_SELECTOR}, [role="menu"][data-state="open"]`)
	)
		return false;
	const selected = selectAttentionCenterTab(useAppStore.getState(), tab.workspaceId);
	return (
		selected?.kind === "changes" && layoutResourceIdentity(selected) === layoutResourceIdentity(tab)
	);
}
