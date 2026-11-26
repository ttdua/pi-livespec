## Design Summary

A request answered in session today goes through a chain of `select` and `input` dialogs. A gate can open three to six of them in a row: the action, "Add notes?", the notes, "Adjust Difficulty or Tags?", then one dialog per unit and field. The facts and the briefing are packed into the title of the first `select`, where long text is hard to read, and the human cannot look back over the whole decision before it is sent.

This change puts each in-session request into one dialog drawn with `ctx.ui.custom()`, modelled on the questionnaire of `@juicesharp/rpiv-ask-user-question` (MIT) but written inside livespec, with no dependency on that package. The human reads the facts and the briefing, picks an option, writes notes, adjusts units when the request allows it, and confirms everything on a Review tab before the answer is sent.

Living requirements this change alters, stated explicitly:
- `approver-adapters` / "In-session adapter": it says the adapter SHALL ask through `ctx.ui.select` and `ctx.ui.input`. This changes: the adapter asks through one custom dialog when the session can draw one, and keeps the `select`/`input` chain as the fallback. The other rules stay: a yes/no answer is never `ctx.ui.confirm`, a cancel is `dismissed`, "answer later" defers a question, a candidate's label is the answer, the adapter never uses `ask_user_question` or any tool or event another extension can answer, `by` is the forge login and the adapter is `in-session`.
- `request-briefing` / "In-session presentation": it says the facts and the briefing are in the title of the first `select`. This changes: in the dialog they are shown as their own sections above the options; the title form stays for the fallback. The entry rules stay: `<label> — <description>`, the recommended entry first and marked ` (Recommended)`, no raw `[<id>]`, identity mapped through the adapter's own table, never inferred from text.
- Unchanged: the briefing is advisory and the answer comes only from the human; agent text is neutralised before it is shown (`request-briefing` / "Agent text is untrusted"); the forge adapter and its comment format are not touched.

### The dialog

```
 Decision · Adjust units · Review
────────────────────────────────────────────────────────
 Gate: define · change #42 rate-limit
 ✓ 4 checks pass   ! 1 waivable: spec-lint

 Agent recommendation (agent-authored, advisory)
 Rate limiting per user; 2 new requirements.
 Watch: - burst size not specified
 Recommended: Approve   Why: scope matches the issue

 › 1 Approve (Recommended)
     Accept the define packet and move to plan.
   2 Request changes
     Send notes back; the agent revises.
   3 Waive spec-lint and approve
     Record the waiver on the issue.
   4 Dismiss
────────────────────────────────────────────────────────
 Note: — (n: add)
 ↑↓ move · 1-9 pick · n note · Tab next · Enter confirm · Esc cancel
```

- **Decision tab:** livespec's facts, then the briefing with its author label, then the options with their descriptions, the recommended one first. A long briefing scrolls; it is never cut off.
- **Notes:** `n` opens a multi-line note editor inside the dialog. "Request changes" needs a note: picking it with no note opens the editor, and the answer cannot be submitted with an empty note.
- **Adjust units tab:** shown only when the request has overridable units. One row per unit with its Difficulty (cycled) and Tags (edited inline).
- **Review tab:** a summary of the outcome, the choice, the notes and any overrides, submitted with `Enter`. Every decision passes through Review before it is sent, also when the request has a single tab.
- **Questions:** the same frame. The options are the candidates plus "Write my own answer" (typed inside the dialog) and "Answer later". The question "Does the answer change a requirement?" is asked on the Review tab.
- **Stuck and rule asks (`decide`):** the same frame with the request's options, no notes requirement and no unit tab.
- **Esc** anywhere cancels the request (`dismissed`); inside a text editor it only closes the editor.
- **Narrow terminal:** below a minimum width the descriptions are hidden, and below the hard minimum the dialog shows one line asking to widen the terminal or press Esc.
- **No custom UI** (RPC mode, or a host where the dialog cannot be drawn): the adapter uses today's `select`/`input` chain, with the same outcomes.

## Alternatives Considered

### Alternative A: Replace only the first step
- **Approach**: a rich dialog for the action choice (facts, briefing, options with previews); notes and unit overrides keep their `select`/`input` dialogs.
- **Pros**: smaller change; less TUI code to test.
- **Cons**: the chain of dialogs stays; no single place to look over the whole decision before sending.
- **Why not chosen**: the main gain of the change is one screen per decision with a review step; this keeps the chain the change is meant to remove.

### Alternative B: Keep the steps, restyle each dialog
- **Approach**: same steps as today, each drawn as a nicer custom dialog.
- **Pros**: no change to the flow or the specs' step logic.
- **Cons**: as many dialogs as today; little gain for the reader.
- **Why not chosen**: the problem is the number of steps and the missing overview, not the look of each step.

### Alternative C: Depend on `rpiv-ask-user-question`
- **Approach**: call the rpiv questionnaire, or its components, for the in-session adapter.
- **Pros**: a mature, tested dialog.
- **Cons**: its answers travel through a tool other extensions and the model can drive, which `approver-adapters` forbids; it pulls in rpiv packages (`rpiv-config`, `rpiv-i18n`) and their release cycle.
- **Why not chosen**: the adapter must call its own UI so the answer can only come from the human; the dialog is modelled on rpiv's interaction, not imported.

### Alternative D: Submit on Enter, no Review tab
- **Approach**: picking an option sends the answer at once; notes are added before picking.
- **Pros**: one key fewer per decision.
- **Cons**: no last look at notes, waivers and overrides before they are recorded on the issue.
- **Why not chosen**: a gate answer is recorded durably and drives the workflow; a final review is worth one key press.

## Agreed Approach

One dialog per request (the design summary above), chosen over Alternatives A and B because it removes the chain of dialogs and gives a single review step, and over Alternative C because the adapter must own its UI. The `select`/`input` chain stays as the fallback, so print, RPC and other hosts behave as today. `@earendil-works/pi-tui` is added as a peer dependency (`"*"`), approved by the user, for width-aware text measurement, truncation and wrapping, the same helpers the pi TUI uses; it is always present in a pi host.

## Key Decisions

- One dialog per request: Decision, Adjust units (only when units are overridable) and Review tabs; every answer passes through Review.
- Notes are written inside the dialog; "Request changes" requires a non-empty note.
- Questions, stuck reports and rule asks use the same frame with their own options; "Write my own answer" and "Answer later" stay for questions.
- `Esc` is `dismissed`, as today; inside an editor it closes the editor only.
- The `select`/`input` chain is the fallback whenever the dialog cannot be drawn; outcomes are the same on both paths.
- No dependency on any rpiv package; the dialog is livespec's own code, modelled on rpiv's interaction (credited as MIT prior art).
- `@earendil-works/pi-tui` becomes a peer dependency (`"*"`), approved by the user.
- The forge adapter, its comment format and the answer record are unchanged.
- The account picker in `src/accounts/resolve.ts`, which also uses `select`, is out of scope.

## Open Questions

- Minimum terminal width for the full layout and for the "widen the terminal" message (proposed: 60 columns full, 40 columns hard minimum); settled in design.
- How the fallback detects that the dialog cannot be drawn (`ctx.mode`, or `custom()` resolving `undefined`); settled in design.
