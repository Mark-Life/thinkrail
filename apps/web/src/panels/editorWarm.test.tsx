import { afterEach, expect, test } from "bun:test";
import {
	ResourceEnvironmentProvider,
	type ResourceHost,
	ResourceHostProvider,
} from "@thinkrail/resource-renderers";
import { renderToStaticMarkup } from "react-dom/server";
import { useEditorWarm } from "./editorWarm";

const host: ResourceHost = {
	markdown: () => null,
	code: { languages: [], languageId: () => null, theme: () => ({ name: "test", settings: [] }) },
	bytesUrl: () => "",
	openFile: () => {},
	openComparison: () => {},
	readFile: async () => ({ content: "" }),
	subscribeFileChanges: () => () => {},
	FileReview: () => null,
	ReviewSend: () => null,
};

afterEach(() => {
	Reflect.deleteProperty(navigator, "connection");
});

function warmAvailable() {
	const seen: boolean[] = [];
	function Probe() {
		seen.push(useEditorWarm() !== undefined);
		return null;
	}
	renderToStaticMarkup(
		<ResourceHostProvider value={host}>
			<ResourceEnvironmentProvider value={{ mobile: false }}>
				<Probe />
			</ResourceEnvironmentProvider>
		</ResourceHostProvider>,
	);
	return seen[0];
}

test("useEditorWarm offers the preload on a desktop connection", () => {
	expect(warmAvailable()).toBe(true);
});

test("useEditorWarm withholds the preload when the connection saves data", () => {
	Object.defineProperty(navigator, "connection", {
		value: { saveData: true },
		configurable: true,
	});
	expect(warmAvailable()).toBe(false);
});
