import { existsSync, readFileSync } from "node:fs";
import { removeTree } from "@thinkrail/shared/removeTree";
import {
	E2E_BINARY_CACHE,
	E2E_DATA_DIR,
	E2E_DESKTOP_CACHE,
	E2E_WS_RESULT_LOG,
} from "./fixtures/paths";

export default function globalTeardown(): void {
	const failures = existsSync(E2E_WS_RESULT_LOG) ? readFileSync(E2E_WS_RESULT_LOG, "utf8") : "";
	removeTree(E2E_DATA_DIR);
	removeTree(E2E_BINARY_CACHE);
	removeTree(E2E_DESKTOP_CACHE);
	if (failures) throw new Error(`Host replies broke their result schemas:\n${failures}`);
}
