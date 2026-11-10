---
"@thinkrail/pi-visualize": minor
---

Hosts can pass `mockupGuideline` to `createVisualizeExtension` to replace how the prompt guideline tells
the model to write a mockup, for example to name a theme file the host provides. The rest of the
guideline stays: show the mockup with `type: "file"`, and copy a proposal to keep it as `before`.
With `mockupGuideline`, `scratchDir` is not used. Without the option the guideline text is unchanged.
