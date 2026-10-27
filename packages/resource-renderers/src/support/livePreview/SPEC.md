---
id: submodule-resource-renderers-live-preview
type: submodule-design
status: active
title: livePreview — the CodeMirror 6 markdown live preview
parent: module-resource-renderers
tags: [public-surface-checked]
---

## Responsibility

The CodeMirror extensions, pure syntax rules and session binding behind the markdown live preview: the
GFM language, markers that hide off the caret, block widgets rendered through the host markdown, review
threads, conflicts, presence, list Enter and find. `LiveMarkdownEditor` (and its `LiveFindBar`) mount the
view and render the React portals; this directory owns everything that runs inside the view.

## Boundary

- **Public surface (barrel):** `bindSession`, `editorSelection`, `SessionBinding`, `livePreview`, `liveText`, `portalHost`,
  `setConflicts`, `setThreads`, `ThreadAnchor`, `markdownLanguage`, `linkHrefAt`,
  `linkTarget`, `continueList`, `newlineKeepingIndent`, `createPortalHost`, `PortalEntry`,
  `livePresence`, `livePresenceSurface`, `liveFind`, `FIND_FIELD`.
- **Allowed deps:** `@codemirror/state`, `@codemirror/view`, `@codemirror/language`,
  `@codemirror/search`, `@lezer/markdown`, `@lezer/common`; the package's `registry` types and the
  engine-neutral `support` rules `conflictLayout`, `editKind`, `markdownAlerts`, `markdownLinks`,
  `presenceCore` and `presenceDecorations`.
- **Forbidden:** importing React or rendering components (the editor renders portals from the entries
  this directory reports; `markdownAlerts` and `markdownLinks` are used only for their pure rules), Monaco, the host
  (`useResourceHost`), and `@codemirror/lang-markdown`.

## Design

- **Binding (`binding.ts`).** One view per session, like the Monaco mirror: the view's own
  transactions go to `applyLocal` with their `LocalEditKind` and the selection to `select`; subscribed
  updates land as one `remote`, `addToHistory: false` transaction, so the view has no history of its
  own: Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z, Ctrl+Y and a `beforeinput` `historyUndo`/`historyRedo` (the
  desktop Edit menu) call the session. A new view starts at the session's `selection()`, scrolled
  into view when no scroll position was saved. Composition start and end go to `setComposing`. Open conflicts
  render as block widgets: the lens above the user's lines (the same **Mine** / **Theirs** / **Both**
  as Monaco, through `ConflictLens` and `ConflictTheirs`) and the disk lines below, with the user's lines washed.
- **Markers (`markers.ts`, pure).** Syntax markers hide unless the selection touches their node,
  and only while focus is inside the editor (the text, the find bar or a widget's controls), so an
  unfocused page reads like the reading view and a click into a thread card or the find bar keeps the
  source it was opened over: inline
  nodes (emphasis, strong, strikethrough, inline code, links, autolinks, escapes) reveal when the
  selection touches the node, line markers (heading `#`, quote `>`, list bullets, task boxes, rules)
  when it touches the line. A shown marker is mono in `text-muted`, the quiet tier that keeps the 4.5:1 floor, since it is text
  the user reads and edits. Off the caret a bullet draws as `•`, a task
  box as a checkbox that toggles the source, named by its item's text and keeping its DOM and focus
  across a toggle, a rule as a line. Link targets hide with their brackets,
  line by line (CodeMirror refuses a plugin decoration that hides a line break); brackets with no URL
  and no matching reference definition (`array[0]`, `[WIP]`) stay literal text, as in CommonMark.
  Cmd/Ctrl+click, or Cmd/Ctrl+Enter with the caret on a link, follows it: an anchor finds its heading
  by the reading view's ids (syntax tree headings, `-n` for repeats) and puts the caret on it, and only `http`, `https` and
  `mailto` open outside the app; a bare or `<…>` email autolink opens as `mailto:`, as in the reading view.
  A plain click on an anchor link inside a block widget takes the same path, never the reading view's
  global id lookup. The quote marks of a fence inside a quote hide off the caret like any other line's. Inline marks are built only over the visible ranges.
- **Blocks (`blocks.ts`, pure).** Tables, GitHub alerts, fenced code (Mermaid included), HTML
  blocks, a paragraph that is only an image, and the front matter render as block widgets while the
  selection is outside them, reusing the host markdown through `MarkdownDocument` (same sanitizing,
  links, Shiki and Mermaid) in React portals; the front matter shows as a one-line summary. Clicking
  a widget away from its controls puts the caret in the block and shows its source. A table, alert,
  HTML or image widget that holds a `[` gets the document's link reference definitions appended to its
  source, so `[text][ref]` resolves as in the reading view; footnotes are not carried. A block that holds
  an open conflict stays source, so its lens and lines show; a presence mark inside a rendered block
  is not drawn (the chip still names the writer). The block candidates come from one walk per parse,
  cached with the front matter by document, so a caret move only re-filters them and keeps the
  decorations when no block enters or leaves. A block nested in
  a list renders dedented by columns (a tab counts to the next stop of 4), so a tab-indented fence
  stays a fence; one inside a quote stays source. An HTML block ends at a blank line, as in CommonMark,
  so an element whose first block leaves its tag open (`<details>`, `<div align=center>`) runs to the
  sibling HTML block that closes it and renders as one widget with its markdown body, as the reading
  view does; an unclosed or void tag stays one block. An inline image stays source. A widget keeps its DOM while its source is unchanged, and every widget's size change
  asks CodeMirror to measure again. Widgets reset the editor's `white-space: pre`, or the newlines
  react-markdown leaves between elements would render as blank lines.
- **Review threads** render as block widgets after their end line (`ReviewThreadCard`), or after the
  rendered block that holds that line, as the reading view does. Authoring a
  comment needs the lock (the reading view's commenting) or Source. A review focus scrolls its line
  into view. The view is React state, so the threads and the widget labels are pushed once per view
  and once per change of `review` or the locale, never twice on mount.
- **Presence** uses the shared rules (`presenceCore.ts`) through a CodeMirror surface: a bar and a
  wash on the changed lines (the bar sits in the content's left padding, since the scroller clips
  anything left of it), the flag after the first line (the core's pill, so it matches Monaco's), the chip at the top right, the writer and
  diff on hover. Marks are line classes, so two writers on one line show the later one's tone. The
  wash fades a `::before` layer behind the line's text, never the line box, which would fade the text.
- **Front matter** (`language.ts`). The parser blanks the front matter lines (`---` open, a `---` or
  `...` close from line 3 on) before `@lezer/markdown` sees them, so no node starts inside it and runs
  into the body; positions stay the same. A tree records the blanked length, and an incremental parse
  reuses only fragments of trees with the same length, since an edit on line 1 can change it.
- **Typography** is the `doc` prose system: the editor content carries `tr-prose-doc`; the lens,
  disk lines and thread cards mounted inside it carry `tr-prose-exempt`, so they look as in Monaco and
  the reading view; heading and
  code lines carry the classes the generator maps next to the elements (`md-h1`…`md-h6`,
  `md-code`, `md-codeblock`), and spacing is line padding, since CodeMirror measures line boxes and
  margins between lines break its height map. The measure is the reading view's 78ch; with the lock shown, both
  views keep a right padding that clears it, so neither text nor the find bar runs under it.
- **Access.** The content is a labelled multi-line textbox with the browser's spell check and
  autocorrect on, since it is prose; Tab leaves the editor (no tab binding);
  heading lines carry `role="heading"` and their level. The focused editor rings its pane. Widget controls stay keyboard reachable.
  Reduced motion drops the presence fades. Enter on a list item starts the next one, inside a quote
  too (an empty item ends the list), outside code. Any other Enter keeps the line's quote marks and
  leading whitespace, so a fence or paragraph inside a list item or a quote stays in it; an empty
  quoted line outside code ends one quote level.
- **Find.** Matches use Monaco's find roles (`feedback-warning-subtle`, the current one
  `editor-find-match-bg`), so Source and Preview mark them alike. CodeMirror renders only the lines near the viewport, so the browser's find cannot reach
  the rest. Cmd/Ctrl+F in the editor opens a find bar (`find.ts` over `@codemirror/search`, React in
  `LiveFindBar` through the portal host) above the text: Enter and Cmd/Ctrl+G or F3 go to the next
  match, with Shift the previous one, and Escape closes it and puts focus back in the text.
- **Cost.** Entry chunk unchanged (1,663 kB, 527 kB gzip). `MarkdownPreview` grows from 13.1 to
  16.2 kB (5.5 to 6.7 kB gzip). The editor chunk is 83.0 kB (29.2 kB gzip, find included) plus one CodeMirror chunk
  of 270.6 kB (87.6 kB gzip: state, commands, view, language) that it shares with the editing
  registry ([[submodule-web-editing]]).
