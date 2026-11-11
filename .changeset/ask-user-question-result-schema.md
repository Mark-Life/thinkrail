---
"@thinkrail/pi-ask-user-question": minor
---

The package now depends on `@earendil-works/pi-schema`, and lists `@earendil-works/pi-ai` as a peer dependency because `./core` types its messages with pi-ai's types. The answer, result and ack shapes are pi-schema
schemas (`AskUserQuestionAnswer`, `AskUserQuestionResult`, `AskUserQuestionAckDetails`), and
`isAskUserQuestionResult` / `isAckDetails` are their compiled checks, so a result with a malformed answer
is now refused. The argument types derive from the tool's TypeBox schema.

`./core` changes for browser use: it no longer loads `@earendil-works/pi-coding-agent`, so `AskRequest` and
`AskUserQuestionAsker` are exported from the package root only. It adds `ANSWER_KINDS` and
`NON_EXECUTABLE_STOP_REASONS`. `isAskUserQuestionArgs` is replaced by `isAskUserQuestionArgsView` and
`isAskUserQuestionItemView`: compiled checks of `AskUserQuestionArgsView`, `AskUserQuestionItemView` and
`AskUserQuestionOptionView`, the shape a host reads of args that may still stream. Only the question text and
option labels are required, and every field the views name is checked. `buildQuestionnaireResponse` takes
any `QuestionTexts`, so a host can pass a checked view. `executableAskCallIds` and
`isolateAskUserQuestionBatch` take pi-ai's `AssistantMessage`; callers narrow by `role` first.
