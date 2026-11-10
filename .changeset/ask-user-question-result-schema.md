---
"@thinkrail/pi-ask-user-question": minor
---

The package now depends on `@earendil-works/pi-schema`. The answer, result and ack shapes are pi-schema
schemas (`AskUserQuestionAnswer`, `AskUserQuestionResult`, `AskUserQuestionAckDetails`), and
`isAskUserQuestionResult` / `isAckDetails` are their compiled checks, so a result with a malformed answer
is now refused. The argument types derive from the tool's TypeBox schema.

`./core` changes for browser use: it no longer loads `@earendil-works/pi-coding-agent`, so `AskRequest` and
`AskUserQuestionAsker` are exported from the package root only. It adds `ANSWER_KINDS`,
`NON_EXECUTABLE_STOP_REASONS` and `isAskUserQuestionItem`. `executableAskCallIds` and
`isolateAskUserQuestionBatch` take pi-ai's `AssistantMessage`; callers narrow by `role` first.
