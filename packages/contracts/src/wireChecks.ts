import {
	compile,
	type JsonSchema,
	type Schema,
	type Static,
	type Validator,
} from "@earendil-works/pi-schema";
import type { SessionEventPayload } from "./piProtocol";
import { AnyHostWelcome, WS_CHANNEL_SCHEMAS as C, WS_METHOD_SCHEMAS as M } from "./schema";
import {
	WS_CHANNELS,
	type WsChannel,
	type WsChannelMap,
	type WsChannelPayload,
	type WsMethodName,
	type WsResult,
} from "./wsProtocol";

const MAX_DESCRIBED_ERRORS = 5;

/** A checked wire value, or why its schema refused it. */
export type Parsed<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly problem: string };

/** What a client may receive: a welcome from a host of any version only meets its floor. */
export interface WsClientChannelMap extends Omit<WsChannelMap, "server.welcome"> {
	"server.welcome": AnyHostWelcome;
}
export type WsClientPayload<K extends WsChannel> = WsClientChannelMap[K];

/** Why `value` fails `validator`: up to five `path message` pairs. `root` names the value itself. */
export function describeFailure<T>(validator: Validator<T>, value: unknown, root: string) {
	return validator
		.errors(value)
		.slice(0, MAX_DESCRIBED_ERRORS)
		.map((error) => `${error.path || root} ${error.message}`)
		.join("; ");
}

function lazyValidator<S extends JsonSchema>(schema: S) {
	let validator: Validator<Static<S>> | undefined;
	return () => {
		validator ??= compile(schema);
		return validator;
	};
}

type ResultValidators = { readonly [K in WsMethodName]: () => Validator<WsResult<K>> };

const RESULTS: ResultValidators = {
	"project.open": lazyValidator(M["project.open"].result),
	"project.list": lazyValidator(M["project.list"].result),
	"project.close": lazyValidator(M["project.close"].result),
	"project.rename": lazyValidator(M["project.rename"].result),
	"project.inspect": lazyValidator(M["project.inspect"].result),
	"project.init": lazyValidator(M["project.init"].result),
	"project.create": lazyValidator(M["project.create"].result),
	"project.cloneDestination": lazyValidator(M["project.cloneDestination"].result),
	"project.clone": lazyValidator(M["project.clone"].result),
	"project.cancelClone": lazyValidator(M["project.cancelClone"].result),
	"project.hasSpecs": lazyValidator(M["project.hasSpecs"].result),
	"project.setTrust": lazyValidator(M["project.setTrust"].result),
	"project.acknowledgeSkills": lazyValidator(M["project.acknowledgeSkills"].result),
	"project.setSkillEnabled": lazyValidator(M["project.setSkillEnabled"].result),
	"project.aliasSkills": lazyValidator(M["project.aliasSkills"].result),
	"project.trustSummary": lazyValidator(M["project.trustSummary"].result),
	"project.setGroupEnabled": lazyValidator(M["project.setGroupEnabled"].result),
	"project.skills": lazyValidator(M["project.skills"].result),
	"model.list": lazyValidator(M["model.list"].result),
	"model.clampThinking": lazyValidator(M["model.clampThinking"].result),
	"model.refresh": lazyValidator(M["model.refresh"].result),
	"model.default": lazyValidator(M["model.default"].result),
	"model.contextSettings": lazyValidator(M["model.contextSettings"].result),
	"model.setContextWindow": lazyValidator(M["model.setContextWindow"].result),
	"customEndpoints.list": lazyValidator(M["customEndpoints.list"].result),
	"customEndpoints.probe": lazyValidator(M["customEndpoints.probe"].result),
	"customEndpoints.save": lazyValidator(M["customEndpoints.save"].result),
	"customEndpoints.remove": lazyValidator(M["customEndpoints.remove"].result),
	"provider.status": lazyValidator(M["provider.status"].result),
	"provider.detect": lazyValidator(M["provider.detect"].result),
	"provider.loginStart": lazyValidator(M["provider.loginStart"].result),
	"provider.loginReply": lazyValidator(M["provider.loginReply"].result),
	"provider.loginCancel": lazyValidator(M["provider.loginCancel"].result),
	"provider.logout": lazyValidator(M["provider.logout"].result),
	"provider.disableWarning": lazyValidator(M["provider.disableWarning"].result),
	"provider.jbcentralConnect": lazyValidator(M["provider.jbcentralConnect"].result),
	"provider.jbcentralDisconnect": lazyValidator(M["provider.jbcentralDisconnect"].result),
	"provider.jbcentralStartProxy": lazyValidator(M["provider.jbcentralStartProxy"].result),
	"provider.jbcentralLogin": lazyValidator(M["provider.jbcentralLogin"].result),
	"provider.jbcentralUpdate": lazyValidator(M["provider.jbcentralUpdate"].result),
	"provider.jbcentralQuota": lazyValidator(M["provider.jbcentralQuota"].result),
	"session.create": lazyValidator(M["session.create"].result),
	"session.prompt": lazyValidator(M["session.prompt"].result),
	"session.steer": lazyValidator(M["session.steer"].result),
	"session.followUp": lazyValidator(M["session.followUp"].result),
	"session.clearQueue": lazyValidator(M["session.clearQueue"].result),
	"session.removeQueued": lazyValidator(M["session.removeQueued"].result),
	"session.abort": lazyValidator(M["session.abort"].result),
	"session.dispose": lazyValidator(M["session.dispose"].result),
	"session.delete": lazyValidator(M["session.delete"].result),
	"session.rename": lazyValidator(M["session.rename"].result),
	"session.setModel": lazyValidator(M["session.setModel"].result),
	"session.setThinkingLevel": lazyValidator(M["session.setThinkingLevel"].result),
	"session.compact": lazyValidator(M["session.compact"].result),
	"session.getStats": lazyValidator(M["session.getStats"].result),
	"session.getCommands": lazyValidator(M["session.getCommands"].result),
	"session.reloadResources": lazyValidator(M["session.reloadResources"].result),
	"session.extUiReply": lazyValidator(M["session.extUiReply"].result),
	"session.respondToTool": lazyValidator(M["session.respondToTool"].result),
	"session.answerQuestion": lazyValidator(M["session.answerQuestion"].result),
	"session.list": lazyValidator(M["session.list"].result),
	"session.stateList": lazyValidator(M["session.stateList"].result),
	"session.acknowledgeCompletion": lazyValidator(M["session.acknowledgeCompletion"].result),
	"session.nudge": lazyValidator(M["session.nudge"].result),
	"session.activityList": lazyValidator(M["session.activityList"].result),
	"session.getMessages": lazyValidator(M["session.getMessages"].result),
	"session.resources": lazyValidator(M["session.resources"].result),
	"session.resourceHistory": lazyValidator(M["session.resourceHistory"].result),
	"backgroundCommand.output": lazyValidator(M["backgroundCommand.output"].result),
	"backgroundCommand.stop": lazyValidator(M["backgroundCommand.stop"].result),
	"subagent.stop": lazyValidator(M["subagent.stop"].result),
	"subagent.stopAll": lazyValidator(M["subagent.stopAll"].result),
	"subagent.getTranscript": lazyValidator(M["subagent.getTranscript"].result),
	"workspace.create": lazyValidator(M["workspace.create"].result),
	"workspace.startCreate": lazyValidator(M["workspace.startCreate"].result),
	"workspace.listCreations": lazyValidator(M["workspace.listCreations"].result),
	"workspace.retryCreation": lazyValidator(M["workspace.retryCreation"].result),
	"workspace.dismissCreation": lazyValidator(M["workspace.dismissCreation"].result),
	"workspace.rename": lazyValidator(M["workspace.rename"].result),
	"workspace.listExisting": lazyValidator(M["workspace.listExisting"].result),
	"workspace.openExisting": lazyValidator(M["workspace.openExisting"].result),
	"workspace.list": lazyValidator(M["workspace.list"].result),
	"workspace.openReview": lazyValidator(M["workspace.openReview"].result),
	"workspace.branchStatus": lazyValidator(M["workspace.branchStatus"].result),
	"workspace.push": lazyValidator(M["workspace.push"].result),
	"workspace.deleteRemoteBranch": lazyValidator(M["workspace.deleteRemoteBranch"].result),
	"workspace.remove": lazyValidator(M["workspace.remove"].result),
	"workspace.diffStats": lazyValidator(M["workspace.diffStats"].result),
	"workspace.setSkillOverride": lazyValidator(M["workspace.setSkillOverride"].result),
	"workspace.setSubagentsOverride": lazyValidator(M["workspace.setSubagentsOverride"].result),
	"workspace.setSubagentMaxConcurrent": lazyValidator(
		M["workspace.setSubagentMaxConcurrent"].result,
	),
	"workspace.setDiffBase": lazyValidator(M["workspace.setDiffBase"].result),
	"workspace.settle": lazyValidator(M["workspace.settle"].result),
	"workspace.unsettle": lazyValidator(M["workspace.unsettle"].result),
	"workspace.markUnread": lazyValidator(M["workspace.markUnread"].result),
	"workspace.markRead": lazyValidator(M["workspace.markRead"].result),
	"workspace.watchReady": lazyValidator(M["workspace.watchReady"].result),
	"workspace.openIn": lazyValidator(M["workspace.openIn"].result),
	"workspace.reveal": lazyValidator(M["workspace.reveal"].result),
	"workspace.turns": lazyValidator(M["workspace.turns"].result),
	"editor.list": lazyValidator(M["editor.list"].result),
	"terminal.reserve": lazyValidator(M["terminal.reserve"].result),
	"terminal.attach": lazyValidator(M["terminal.attach"].result),
	"terminal.list": lazyValidator(M["terminal.list"].result),
	"terminal.write": lazyValidator(M["terminal.write"].result),
	"terminal.resize": lazyValidator(M["terminal.resize"].result),
	"terminal.close": lazyValidator(M["terminal.close"].result),
	"git.listBranches": lazyValidator(M["git.listBranches"].result),
	"git.prefetch": lazyValidator(M["git.prefetch"].result),
	"git.status": lazyValidator(M["git.status"].result),
	"git.diffFile": lazyValidator(M["git.diffFile"].result),
	"git.listCommits": lazyValidator(M["git.listCommits"].result),
	"change.revert": lazyValidator(M["change.revert"].result),
	"change.undo": lazyValidator(M["change.undo"].result),
	"fs.readDir": lazyValidator(M["fs.readDir"].result),
	"fs.readFile": lazyValidator(M["fs.readFile"].result),
	"spec.graph": lazyValidator(M["spec.graph"].result),
	"github.authStatus": lazyValidator(M["github.authStatus"].result),
	"github.refresh": lazyValidator(M["github.refresh"].result),
	"pr.preview": lazyValidator(M["pr.preview"].result),
	"pr.open": lazyValidator(M["pr.open"].result),
	"pr.generate": lazyValidator(M["pr.generate"].result),
	"pr.ready": lazyValidator(M["pr.ready"].result),
	"pr.merge": lazyValidator(M["pr.merge"].result),
	"pr.reopen": lazyValidator(M["pr.reopen"].result),
	"todo.list": lazyValidator(M["todo.list"].result),
	"todo.add": lazyValidator(M["todo.add"].result),
	"todo.update": lazyValidator(M["todo.update"].result),
	"todo.remove": lazyValidator(M["todo.remove"].result),
	"todo.review": lazyValidator(M["todo.review"].result),
	"todo.requestFix": lazyValidator(M["todo.requestFix"].result),
	"todo.startReview": lazyValidator(M["todo.startReview"].result),
	"todo.reviewAll": lazyValidator(M["todo.reviewAll"].result),
	"todo.generateSummary": lazyValidator(M["todo.generateSummary"].result),
	"review.get": lazyValidator(M["review.get"].result),
	"review.commentAdd": lazyValidator(M["review.commentAdd"].result),
	"review.commentUpdate": lazyValidator(M["review.commentUpdate"].result),
	"review.commentDelete": lazyValidator(M["review.commentDelete"].result),
	"review.fileDone": lazyValidator(M["review.fileDone"].result),
	"review.sendComment": lazyValidator(M["review.sendComment"].result),
	"review.sendBatch": lazyValidator(M["review.sendBatch"].result),
	"review.close": lazyValidator(M["review.close"].result),
	"template.list": lazyValidator(M["template.list"].result),
	"template.get": lazyValidator(M["template.get"].result),
	"template.save": lazyValidator(M["template.save"].result),
	"template.delete": lazyValidator(M["template.delete"].result),
	"mcp.list": lazyValidator(M["mcp.list"].result),
	"mcp.add": lazyValidator(M["mcp.add"].result),
	"mcp.update": lazyValidator(M["mcp.update"].result),
	"mcp.remove": lazyValidator(M["mcp.remove"].result),
	"mcp.setProjectOverride": lazyValidator(M["mcp.setProjectOverride"].result),
	"mcp.setSessionOverride": lazyValidator(M["mcp.setSessionOverride"].result),
	"mcp.approve": lazyValidator(M["mcp.approve"].result),
	"mcp.revokeToolGrant": lazyValidator(M["mcp.revokeToolGrant"].result),
	"mcp.shareWithRepo": lazyValidator(M["mcp.shareWithRepo"].result),
	"mcp.login": lazyValidator(M["mcp.login"].result),
	"mcp.logout": lazyValidator(M["mcp.logout"].result),
	"mcp.testConnection": lazyValidator(M["mcp.testConnection"].result),
	"mcp.reconnect": lazyValidator(M["mcp.reconnect"].result),
	"mcp.readOutput": lazyValidator(M["mcp.readOutput"].result),
	"mcp.readLog": lazyValidator(M["mcp.readLog"].result),
	"packages.list": lazyValidator(M["packages.list"].result),
	"packages.install": lazyValidator(M["packages.install"].result),
	"packages.remove": lazyValidator(M["packages.remove"].result),
	"packages.update": lazyValidator(M["packages.update"].result),
	"packages.checkUpdates": lazyValidator(M["packages.checkUpdates"].result),
	"packages.setResourceEnabled": lazyValidator(M["packages.setResourceEnabled"].result),
	"packages.reveal": lazyValidator(M["packages.reveal"].result),
	"fonts.list": lazyValidator(M["fonts.list"].result),
	"fonts.installed": lazyValidator(M["fonts.installed"].result),
	"fonts.reveal": lazyValidator(M["fonts.reveal"].result),
	"speech.install": lazyValidator(M["speech.install"].result),
	"speech.cancelInstall": lazyValidator(M["speech.cancelInstall"].result),
	"speech.remove": lazyValidator(M["speech.remove"].result),
	"feedback.respond": lazyValidator(M["feedback.respond"].result),
	"feedback.survey": lazyValidator(M["feedback.survey"].result),
	"feedback.survey.submit": lazyValidator(M["feedback.survey.submit"].result),
	"themes.list": lazyValidator(M["themes.list"].result),
	"themes.reveal": lazyValidator(M["themes.reveal"].result),
	"locales.list": lazyValidator(M["locales.list"].result),
	"locales.reveal": lazyValidator(M["locales.reveal"].result),
	"environment.get": lazyValidator(M["environment.get"].result),
	"environment.update": lazyValidator(M["environment.update"].result),
	"skill.list": lazyValidator(M["skill.list"].result),
	"skills.state": lazyValidator(M["skills.state"].result),
	"settings.update": lazyValidator(M["settings.update"].result),
	"host.update": lazyValidator(M["host.update"].result),
	"history.search": lazyValidator(M["history.search"].result),
	"search.query": lazyValidator(M["search.query"].result),
	"search.preview": lazyValidator(M["search.preview"].result),
	"extension.list": lazyValidator(M["extension.list"].result),
	"dialog.selectDirectory": lazyValidator(M["dialog.selectDirectory"].result),
	"client.reportError": lazyValidator(M["client.reportError"].result),
};

/** The compiled result schema of `method`, built on first use. */
export function wsResultValidator<K extends WsMethodName>(method: K) {
	return RESULTS[method]();
}

/** pi owns its events: the wire checks `sessionId` and `event.type`, and the reducer reads the rest as pi typed it. */
const PiEventPush: Schema<SessionEventPayload> = { allOf: [C["pi.event"]] };

type PushValidators = { readonly [K in WsChannel]: () => Validator<WsChannelPayload<K>> };

const PUSHES: PushValidators = {
	"server.welcome": lazyValidator(C["server.welcome"]),
	"project.updated": lazyValidator(C["project.updated"]),
	"pi.event": lazyValidator(PiEventPush),
	"pi.extensionUi": lazyValidator(C["pi.extensionUi"]),
	"session.created": lazyValidator(C["session.created"]),
	"session.deleted": lazyValidator(C["session.deleted"]),
	"session.resourcesChanged": lazyValidator(C["session.resourcesChanged"]),
	"session.state": lazyValidator(C["session.state"]),
	"provider.login": lazyValidator(C["provider.login"]),
	"provider.changed": lazyValidator(C["provider.changed"]),
	"terminal.data": lazyValidator(C["terminal.data"]),
	"terminal.exit": lazyValidator(C["terminal.exit"]),
	"terminal.detached": lazyValidator(C["terminal.detached"]),
	"terminal.tabs": lazyValidator(C["terminal.tabs"]),
	"workspace.created": lazyValidator(C["workspace.created"]),
	"workspace.updated": lazyValidator(C["workspace.updated"]),
	"workspace.removed": lazyValidator(C["workspace.removed"]),
	"workspace.fsChanged": lazyValidator(C["workspace.fsChanged"]),
	"workspace.creationChanged": lazyValidator(C["workspace.creationChanged"]),
	"workspace.creationRemoved": lazyValidator(C["workspace.creationRemoved"]),
	"settings.changed": lazyValidator(C["settings.changed"]),
	"host.updateAvailable": lazyValidator(C["host.updateAvailable"]),
	"feedback.interview": lazyValidator(C["feedback.interview"]),
	"feedback.githubStar": lazyValidator(C["feedback.githubStar"]),
	"review.changed": lazyValidator(C["review.changed"]),
	"review.failed": lazyValidator(C["review.failed"]),
	"turn.changed": lazyValidator(C["turn.changed"]),
	"mcp.status": lazyValidator(C["mcp.status"]),
	"locales.changed": lazyValidator(C["locales.changed"]),
	"themes.changed": lazyValidator(C["themes.changed"]),
	"packages.changed": lazyValidator(C["packages.changed"]),
	"fonts.changed": lazyValidator(C["fonts.changed"]),
	"speech.changed": lazyValidator(C["speech.changed"]),
};

/** The compiled payload schema of `channel`, as the host sends it, built on first use. */
export function wsPushValidator<K extends WsChannel>(channel: K) {
	return PUSHES[channel]();
}

type ClientPushValidators = { readonly [K in WsChannel]: () => Validator<WsClientPayload<K>> };

const CLIENT_PUSHES: ClientPushValidators = {
	...PUSHES,
	"server.welcome": lazyValidator(AnyHostWelcome),
};

const CHANNELS = new Map<string, WsChannel>(
	Object.values(WS_CHANNELS).map((channel) => [channel, channel]),
);

/** The channel a push names, when this client knows it. */
export function wsChannelOf(name: string) {
	return CHANNELS.get(name);
}

export function parseWsResult<K extends WsMethodName>(
	method: K,
	value: unknown,
): Parsed<WsResult<K>> {
	const validator = wsResultValidator(method);
	if (validator.check(value)) return { ok: true, value };
	return {
		ok: false,
		problem: `${method} replied with a shape its schema refuses: ${describeFailure(validator, value, "result")}`,
	};
}

/** Checks a push as a client reads it, with the welcome floor in place of the full welcome. */
export function parseWsPush<K extends WsChannel>(
	channel: K,
	data: unknown,
): Parsed<WsClientPayload<K>> {
	const validator = CLIENT_PUSHES[channel]();
	if (validator.check(data)) return { ok: true, value: data };
	return {
		ok: false,
		problem: `${channel} pushed a shape its schema refuses: ${describeFailure(validator, data, "data")}`,
	};
}
