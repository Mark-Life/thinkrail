import {
	MAX_HEADER_LENGTH,
	MAX_LABEL_LENGTH,
	MAX_OPTIONS,
	MAX_RECOMMENDED_REASON_LENGTH,
	MIN_OPTIONS,
} from "./core.ts";
import { questionnaireSchemas } from "./questionSchema.ts";

export type { AskUserQuestionParams } from "./questionSchema.ts";

export interface AskUserQuestionSchemaOptions {
	filePreviews?: boolean;
}

const schemas = () =>
	questionnaireSchemas({
		minOptions: MIN_OPTIONS,
		maxOptions: MAX_OPTIONS,
		maxHeaderLength: MAX_HEADER_LENGTH,
		maxLabelLength: MAX_LABEL_LENGTH,
		maxRecommendedReasonLength: MAX_RECOMMENDED_REASON_LENGTH,
	});

export function createAskUserQuestionSchema(options: AskUserQuestionSchemaOptions = {}) {
	const { markdownOnly, filePreview } = schemas();
	return options.filePreviews === true ? filePreview : markdownOnly;
}

export const AskUserQuestionSchema = schemas().markdownOnly;
