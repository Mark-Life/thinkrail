import {
	type HostWelcomeVersions,
	PROTOCOL_MAX_VERSION,
	PROTOCOL_MIN_VERSION,
	PROTOCOL_VERSION,
} from "@thinkrail/contracts";
import type { ProtocolMismatch } from "../store";

export function protocolMismatch(
	host: HostWelcomeVersions,
	client = { version: PROTOCOL_VERSION, min: PROTOCOL_MIN_VERSION, max: PROTOCOL_MAX_VERSION },
): ProtocolMismatch | null {
	const clientAccepts = host.protocolVersion >= client.min && host.protocolVersion <= client.max;
	const hostAccepts =
		client.version >= (host.protocolMin ?? client.version) &&
		client.version <= (host.protocolMax ?? client.version);
	if (clientAccepts && hostAccepts) return null;
	return host.protocolVersion > client.version ? "uiOutdated" : "hostOutdated";
}
