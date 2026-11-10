import { createAskUserQuestionExtension } from "./src/extension.ts";

export type { AskRequest, AskUserQuestionAsker } from "./src/asker.ts";
export type {
	AskOutcome,
	AskToolResult,
	AskUserQuestionAnswerKind,
	AskUserQuestionArgs,
	AskUserQuestionDetails,
	AskUserQuestionDiscussReason,
	AskUserQuestionItem,
	AskUserQuestionOption,
	AskUserQuestionPreviewFields,
	PreviewFileSource,
	QuestionTexts,
	ValidationOptions,
	ValidationResult,
} from "./src/core.ts";
export {
	ANSWER_KINDS,
	ASK_ACK_TEXT,
	ASK_CHAT_TEXT,
	ASK_STOPPED_ERROR,
	ASK_UNAVAILABLE_TEXT,
	ASK_USER_QUESTION_TOOL_NAME,
	AskUserQuestionAckDetails,
	AskUserQuestionAnswer,
	AskUserQuestionArgsView,
	AskUserQuestionItemView,
	AskUserQuestionOptionView,
	AskUserQuestionResult,
	buildQuestionnaireResponse,
	CHAT_LABEL,
	DECLINE_MESSAGE,
	DISCUSS_INSTRUCTION,
	DISCUSS_LABEL,
	DISCUSS_REASONS,
	executableAskCallIds,
	isAckDetails,
	isAskUserQuestionArgsView,
	isAskUserQuestionItemView,
	isAskUserQuestionResult,
	isolateAskUserQuestionBatch,
	MAX_HEADER_LENGTH,
	MAX_LABEL_LENGTH,
	MAX_OPTIONS,
	MAX_RECOMMENDED_REASON_LENGTH,
	MIN_OPTIONS,
	NON_EXECUTABLE_STOP_REASONS,
	OTHER_LABEL,
	outcomeResult,
	previewFileSources,
	RESERVED_LABELS,
	validateQuestionnaire,
} from "./src/core.ts";
export type {
	AskUserQuestionExtensionOptions,
	AskUserQuestionFileChecker,
	AskUserQuestionGuidance,
} from "./src/extension.ts";
export {
	createAskUserQuestionExtension,
	DEFAULT_DESCRIPTION,
	DEFAULT_PROMPT_GUIDELINES,
	defaultDescription,
} from "./src/extension.ts";
export {
	type AskUserQuestionParams,
	AskUserQuestionSchema,
	type AskUserQuestionSchemaOptions,
	createAskUserQuestionSchema,
} from "./src/schema.ts";

export default createAskUserQuestionExtension();
