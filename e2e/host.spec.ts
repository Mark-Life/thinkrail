import { createServer, type Server } from "node:http";
import { expect, type Page, test } from "@playwright/test";

type Dial = "welcome" | "refused";

function hostSocketUrl(baseURL: string | undefined): string {
	if (!baseURL) throw new Error("The host spec needs a baseURL.");
	return `ws://${new URL(baseURL).host}/ws`;
}

function dialFromPage(page: Page, socketUrl: string): Promise<Dial> {
	return page.evaluate(
		(url) =>
			new Promise<Dial>((resolve) => {
				const socket = new WebSocket(url);
				socket.onmessage = (event: MessageEvent<string>) => {
					if (JSON.parse(event.data).channel !== "server.welcome") return;
					resolve("welcome");
					socket.close();
				};
				socket.onclose = () => resolve("refused");
			}),
		socketUrl,
	);
}

function dialFromFrame(page: Page, socketUrl: string, sandbox: string): Promise<Dial> {
	return page.evaluate(
		({ url, sandboxTokens }) =>
			new Promise<Dial>((resolve) => {
				const frame = document.createElement("iframe");
				addEventListener("message", (event: MessageEvent<Dial>) => {
					if (event.source !== frame.contentWindow) return;
					frame.remove();
					resolve(event.data);
				});
				frame.setAttribute("sandbox", sandboxTokens);
				frame.srcdoc = `<script>
					const socket = new WebSocket(${JSON.stringify(url)});
					socket.onopen = () => parent.postMessage("welcome", "*");
					socket.onclose = () => parent.postMessage("refused", "*");
				</script>`;
				document.body.append(frame);
			}),
		{ url: socketUrl, sandboxTokens: sandbox },
	);
}

test.describe("host HTTP surface", () => {
	test("/health returns ok", async ({ request }) => {
		const res = await request.get("/health");
		expect(res.status()).toBe(200);
		expect(await res.text()).toBe("ok");
	});

	test("serves the built SPA at the root", async ({ request }) => {
		const res = await request.get("/");
		expect(res.status()).toBe(200);
		expect(res.headers()["content-type"] ?? "").toContain("text/html");
		expect((await res.text()).toLowerCase()).toContain("<!doctype html>");
	});

	test("falls back to index.html for an unknown client-side route", async ({ request }) => {
		const res = await request.get("/deep/client/route");
		expect(res.status()).toBe(200);
		expect((await res.text()).toLowerCase()).toContain("<!doctype html>");
	});
});

test.describe("host request source", () => {
	let foreign: Server;
	let foreignOrigin: string;

	test.beforeAll(async () => {
		foreign = createServer((_request, response) => {
			response.setHeader("content-type", "text/html");
			response.end("<!doctype html><title>another site</title>");
		});
		await new Promise<void>((resolve) => foreign.listen(0, "127.0.0.1", resolve));
		const address = foreign.address();
		if (address === null || typeof address === "string")
			throw new Error("The foreign site has no port.");
		foreignOrigin = `http://127.0.0.1:${address.port}`;
	});

	test.afterAll(async () => {
		await new Promise<void>((resolve) => foreign.close(() => resolve()));
	});

	test("the app's own page opens the socket", async ({ page, baseURL }) => {
		await page.goto("/");
		expect(await dialFromPage(page, hostSocketUrl(baseURL))).toBe("welcome");
	});

	test("a page on another origin is refused", async ({ page, baseURL }) => {
		await page.goto(foreignOrigin);
		const reachable = await page.evaluate(
			(url) =>
				fetch(url, { mode: "no-cors" }).then(
					() => true,
					() => false,
				),
			new URL("/health", baseURL).href,
		);
		expect(reachable).toBe(true);
		expect(await dialFromPage(page, hostSocketUrl(baseURL))).toBe("refused");
	});

	test("a sandboxed frame inside the app is refused", async ({ page, baseURL }) => {
		await page.goto("/");
		const socketUrl = hostSocketUrl(baseURL);
		expect(await dialFromFrame(page, socketUrl, "allow-scripts allow-same-origin")).toBe("welcome");
		expect(await dialFromFrame(page, socketUrl, "allow-scripts")).toBe("refused");
	});
});
