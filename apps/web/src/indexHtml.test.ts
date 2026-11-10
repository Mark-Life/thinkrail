import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("the app page forbids URL frames before any script can run", () => {
	const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
	const policy = `<meta http-equiv="Content-Security-Policy" content="frame-src 'none'" />`;
	const at = html.indexOf(policy);
	expect(at).toBeGreaterThan(html.indexOf("<head>"));
	expect(at).toBeLessThan(html.indexOf("<script"));
	expect(html.match(/Content-Security-Policy/g)).toHaveLength(1);
});
