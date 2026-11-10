import { WS_ERROR_CODES, type WsErrorCode } from "@thinkrail/contracts";

export class RequestError extends Error {
	readonly code: WsErrorCode;

	constructor(code: WsErrorCode, message: string) {
		super(message);
		this.name = "RequestError";
		this.code = code;
	}
}

export function knownErrorCode(code: string | undefined): WsErrorCode | undefined {
	return WS_ERROR_CODES.find((known) => known === code);
}

export function wsErrorCode(err: unknown): WsErrorCode | undefined {
	return err instanceof RequestError ? err.code : undefined;
}

/** The host did not answer within the request's `timeoutMs`; the request may still complete there. */
export class RequestTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RequestTimeoutError";
	}
}
