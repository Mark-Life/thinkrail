import { Type } from "typebox";
import { Check } from "typebox/value";

const ErrnoCauseSchema = Type.Object({ code: Type.String() });

export function errnoCode(cause: unknown): string | undefined {
	return Check(ErrnoCauseSchema, cause) ? cause.code : undefined;
}
