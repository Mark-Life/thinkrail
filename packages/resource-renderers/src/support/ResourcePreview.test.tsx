import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ResourceEnvironmentProvider, type ResourceHost, ResourceHostProvider } from "../host";
import { forgetNaturalHeight, naturalHeightKey, rememberNaturalHeight } from "./naturalHeights";
import { ResourcePreview } from "./ResourcePreview";

const host = {
	readFile: () => new Promise(() => {}),
	subscribeFileChanges: () => () => {},
	bytesUrl: () => "",
} as unknown as ResourceHost;

function loadingMarkup(fitContent: boolean): string {
	return renderToStaticMarkup(
		<ResourceEnvironmentProvider value={{ mobile: false }}>
			<ResourceHostProvider value={host}>
				<ResourcePreview
					workspaceId="w-held"
					path="./mockups/held.html"
					className="h-[480px]"
					fitContent={fitContent}
				/>
			</ResourceHostProvider>
		</ResourceEnvironmentProvider>,
	);
}

test("a fitted preview loads at the height its natural frame last had", () => {
	const key = naturalHeightKey("w-held", "mockups/held.html");
	expect(loadingMarkup(true)).toContain("h-[480px]");
	rememberNaturalHeight(key, "thinkrail/html\u0000h1", 1662);
	try {
		const held = loadingMarkup(true);
		expect(held).toContain("--resource-preview-height:1662px");
		expect(held).toContain("h-[var(--resource-preview-height)]");
		expect(held).not.toContain("h-[480px]");
		expect(loadingMarkup(false)).not.toContain("--resource-preview-height");
	} finally {
		forgetNaturalHeight(key);
	}
});
