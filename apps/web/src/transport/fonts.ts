import {
	parseUserFontFile,
	USER_FONT_UPLOAD_HEADER,
	USER_FONTS_ROUTE,
	type UserFontFile,
} from "@thinkrail/contracts";
import { RequestError } from "./requestError";
import { getTransport } from "./wireTransport";

export function hostUrl(path: string): string {
	return `${getTransport().httpBase()}${path}`;
}

export async function uploadUserFont(file: File): Promise<UserFontFile> {
	const response = await fetch(hostUrl(`${USER_FONTS_ROUTE}${encodeURIComponent(file.name)}`), {
		method: "PUT",
		headers: { [USER_FONT_UPLOAD_HEADER.name]: USER_FONT_UPLOAD_HEADER.value },
		body: file,
	});
	const failure = new RequestError(
		"FONT_UPLOAD_FAILED",
		`font upload failed with HTTP ${response.status}`,
	);
	const text = await response.text();
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw failure;
	}
	const entry = parseUserFontFile(body);
	if (entry) return entry;
	throw failure;
}
