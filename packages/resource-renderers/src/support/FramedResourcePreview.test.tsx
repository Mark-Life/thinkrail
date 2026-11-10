import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FramedResourcePreview } from "./FramedResourcePreview";

describe("FramedResourcePreview", () => {
	it("renders nothing without a host and a workspace scope", () => {
		expect(
			renderToStaticMarkup(
				<FramedResourcePreview
					path="mockups/a.html"
					title="mockups/a.html"
					frameClassName="h-[380px]"
					testIdPrefix="test-preview"
				/>,
			),
		).toBe("");
	});
});
