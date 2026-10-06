import { expect, test } from "bun:test";
import { lazy, type ReactNode, Suspense } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { preloadedLazy } from "./preloadedLazy";

function Greeting({ name }: { name: string }) {
	return <p>hello {name}</p>;
}

const render = (node: ReactNode) =>
	renderToStaticMarkup(<Suspense fallback={<p>loading</p>}>{node}</Suspense>);

test("loads only on preload, once, and renders without suspending once loaded", async () => {
	let calls = 0;
	const load = Promise.resolve({ default: Greeting });
	const Preloaded = preloadedLazy(() => {
		calls += 1;
		return load;
	});
	expect(calls).toBe(0);
	await Preloaded.preload();
	await Preloaded.preload();
	expect(calls).toBe(1);
	expect(render(<Preloaded name="chat" />)).toBe("<p>hello chat</p>");
});

test("a plain lazy component still suspends after its module resolved", async () => {
	const load = Promise.resolve({ default: Greeting });
	const Lazy = lazy(() => load);
	await load;
	expect(render(<Lazy name="chat" />)).toContain("loading");
});

test("suspends while the module is still loading", () => {
	const Preloaded = preloadedLazy(() => new Promise<{ default: typeof Greeting }>(() => {}));
	void Preloaded.preload();
	expect(render(<Preloaded name="chat" />)).toContain("loading");
});
