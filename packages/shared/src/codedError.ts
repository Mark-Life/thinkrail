import type { WsErrorCode } from "@thinkrail/contracts";

export class CodedError extends Error {
	readonly code: WsErrorCode;

	constructor(code: WsErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "CodedError";
		this.code = code;
	}
}

export function errorCodeOf(err: unknown): WsErrorCode | undefined {
	return err instanceof CodedError ? err.code : undefined;
}
