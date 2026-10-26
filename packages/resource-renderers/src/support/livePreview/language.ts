import { defineLanguageFacet, Language, languageDataProp } from "@codemirror/language";
import { GFM, parser } from "@lezer/markdown";

const data = defineLanguageFacet();

export const markdownParser = parser.configure([
	GFM,
	{ props: [languageDataProp.add({ Document: data })] },
]);

export const markdownLanguage = new Language(data, markdownParser, [], "markdown");
