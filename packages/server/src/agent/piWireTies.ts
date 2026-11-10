import type {
	SlashCommandInfo as PiSlashCommandInfo,
	SourceInfo,
} from "@earendil-works/pi-coding-agent";
import type { Same, SlashCommandInfo, SlashCommandSourceInfo } from "@thinkrail/contracts";

export type SlashCommandInfoTie = Same<
	Omit<SlashCommandInfo, "sourceInfo">,
	Omit<PiSlashCommandInfo, "sourceInfo">
>;
export type SlashCommandSourceInfoTie = Same<
	SlashCommandSourceInfo,
	Pick<SourceInfo, "path" | "source" | "scope" | "origin" | "baseDir">
>;
