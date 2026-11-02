import { compile, type Validator } from "@earendil-works/pi-schema";
import {
	WS_METHOD_SCHEMAS as S,
	type WsMethodName,
	type WsParams,
	type WsSchemaMethodMap,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";

const MAX_REPORTED_ERRORS = 5;

type ParamsValidators = {
	[M in keyof WsSchemaMethodMap]: Validator<WsSchemaMethodMap[M]["params"]>;
};
type MethodValidators = { [M in WsMethodName]?: Validator<WsParams<M>> };

const SCHEMA_VALIDATORS: ParamsValidators = {
	"project.open": compile(S["project.open"].params),
	"project.list": compile(S["project.list"].params),
	"project.close": compile(S["project.close"].params),
	"project.rename": compile(S["project.rename"].params),
	"project.inspect": compile(S["project.inspect"].params),
	"project.init": compile(S["project.init"].params),
	"project.create": compile(S["project.create"].params),
	"project.cloneDestination": compile(S["project.cloneDestination"].params),
	"project.clone": compile(S["project.clone"].params),
	"project.cancelClone": compile(S["project.cancelClone"].params),
	"project.hasSpecs": compile(S["project.hasSpecs"].params),
	"project.setTrust": compile(S["project.setTrust"].params),
	"project.acknowledgeSkills": compile(S["project.acknowledgeSkills"].params),
	"project.setSkillEnabled": compile(S["project.setSkillEnabled"].params),
	"project.aliasSkills": compile(S["project.aliasSkills"].params),
	"project.trustSummary": compile(S["project.trustSummary"].params),
	"project.setGroupEnabled": compile(S["project.setGroupEnabled"].params),
	"project.skills": compile(S["project.skills"].params),
};
const VALIDATORS: MethodValidators = SCHEMA_VALIDATORS;

/** Checks a request's params before its handler runs. @throws `CodedError` `INVALID_PARAMS`. */
export function parseWsParams<M extends WsMethodName>(method: M, raw: unknown): WsParams<M> {
	const validator: MethodValidators[M] = VALIDATORS[method];
	if (!validator) return raw as WsParams<M>;
	if (validator.check(raw)) return raw;
	const reasons = validator
		.errors(raw)
		.slice(0, MAX_REPORTED_ERRORS)
		.map((e) => `${e.path || "params"} ${e.message}`);
	throw new CodedError("INVALID_PARAMS", `Invalid ${method}: ${reasons.join("; ")}`);
}
