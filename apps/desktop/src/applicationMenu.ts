import { compile, obj, str } from "@earendil-works/pi-schema";
import type { NativeCommand } from "@thinkrail/contracts";
import type { DESKTOP_MENU_KEYS } from "@thinkrail/locales";
import type { ApplicationMenuItemConfig } from "electrobun/main";
import { labelReader, type RawLabels } from "./nativeLabels";

const MAX_MENU_LABEL_LENGTH = 80;

export type DesktopMenuLabels = Readonly<Record<(typeof DESKTOP_MENU_KEYS)[number], string>>;

export function readMenuLabels(raw: RawLabels): DesktopMenuLabels {
	const label = labelReader(MAX_MENU_LABEL_LENGTH, raw);
	return {
		"desktop.menu.edit": label("desktop.menu.edit"),
		"desktop.menu.settings": label("desktop.menu.settings"),
		"desktop.menu.quit": label("desktop.menu.quit"),
		"desktop.menu.window": label("desktop.menu.window"),
		"desktop.menu.close": label("desktop.menu.close"),
	};
}

export const DEFAULT_MENU_LABELS: DesktopMenuLabels = readMenuLabels({});

export const QUIT_SHORTCUT_ACTION = "quit-shortcut";
const CLOSE_ITEM_COMMAND: NativeCommand = "close-item";
const OPEN_SETTINGS_COMMAND: NativeCommand = "open-settings";
const NATIVE_COMMANDS = { "close-item": true, "open-settings": true } satisfies Record<
	NativeCommand,
	true
>;

type ApplicationMenuApi = {
	setApplicationMenu(menu: ApplicationMenuItemConfig[]): void;
};

function editMenu(labels: DesktopMenuLabels): ApplicationMenuItemConfig {
	return {
		label: labels["desktop.menu.edit"],
		submenu: [
			{ role: "undo" },
			{ role: "redo" },
			{ type: "separator" },
			{ role: "cut" },
			{ role: "copy" },
			{ role: "paste" },
			{ role: "pasteAndMatchStyle" },
			{ role: "delete" },
			{ role: "selectAll" },
		],
	};
}

export function desktopApplicationMenu(
	platform: NodeJS.Platform,
	labels: DesktopMenuLabels = DEFAULT_MENU_LABELS,
): ApplicationMenuItemConfig[] | null {
	if (platform === "win32") return [editMenu(labels)];
	if (platform !== "darwin") return null;
	return [
		{
			submenu: [
				{ role: "about" },
				{ type: "separator" },
				{
					label: labels["desktop.menu.settings"],
					action: OPEN_SETTINGS_COMMAND,
					accelerator: "CommandOrControl+,",
				},
				{ type: "separator" },
				{ role: "hide", accelerator: "CommandOrControl+H" },
				{ role: "hideOthers", accelerator: "CommandOrControl+Alt+H" },
				{ role: "showAll" },
				{ type: "separator" },
				{
					label: labels["desktop.menu.quit"],
					action: QUIT_SHORTCUT_ACTION,
					accelerator: "CommandOrControl+Q",
				},
			],
		},
		editMenu(labels),
		{
			label: labels["desktop.menu.window"],
			submenu: [
				{ role: "minimize", accelerator: "CommandOrControl+M" },
				{ role: "zoom" },
				{
					label: labels["desktop.menu.close"],
					action: CLOSE_ITEM_COMMAND,
					accelerator: "CommandOrControl+W",
				},
				{ type: "separator" },
				{ role: "bringAllToFront" },
			],
		},
	];
}

export function installDesktopApplicationMenu(
	applicationMenu: ApplicationMenuApi,
	platform: NodeJS.Platform,
	labels: DesktopMenuLabels = DEFAULT_MENU_LABELS,
): boolean {
	const menu = desktopApplicationMenu(platform, labels);
	if (!menu) return false;
	applicationMenu.setApplicationMenu(menu);
	return true;
}

export function isNativeCommand(action: string | null): action is NativeCommand {
	return action !== null && Object.hasOwn(NATIVE_COMMANDS, action);
}

const MenuClick = compile(obj({ data: obj({ action: str() }, { open: true }) }, { open: true }));

export function readMenuAction(event: unknown) {
	return MenuClick.check(event) ? event.data.action : null;
}
