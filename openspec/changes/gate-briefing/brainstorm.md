## Design Summary

**Intent.** Human decisions in livespec (gates, amendments, questions, stuck reports, rule asks) currently reach the reviewer as raw facts: a joined text block in a chain of `select` dialogs, or a forge `request` comment that reads like a log followed by the full `/livespec …` grammar. Nobody tells the reviewer what the change does, what to look at, which answer fits and why. The user wants the agent, which has the full context, to prepare the decision: propose the options, recommend one and explain the reasoning, while the human still decides.

**What changes for the reviewer.**
- Every request carries a **briefing** next to the facts livespec computes: a short summary, points to watch, a recommended option with its rationale, and a description of what each option means or costs.
- Facts come first; the briefing follows, labelled as agent-authored and advisory. Failing checks are stated by livespec, never re-worded by the agent.
- The forge `request` comment becomes readable markdown: a "Decision needed" heading, the recommendation, what is being approved, a checks table, and a short "How to answer" table with copyable commands; the full command list folds away.
- The in-session dialog shows the briefing first and labels options with their description, the recommended one marked "(Recommended)", instead of labels like `waive [waive]`.

**Where the briefing comes from.**
- `spec_gate` (human gates) and `unit_amend`: the agent writes the briefing; it is required for a human gate and optional for a self gate.
- `spec_stuck`: the agent already gives options and a recommended id; each option gains a description and the recommendation gains a rationale.
- `spec_question`: the agent may propose 2-4 candidate answers, each with a description, one recommended with a rationale. The human picks one or writes their own. On the forge each candidate appears as a ready-to-copy `/livespec answer Q<n> …` command; the command grammar does not change.
- `decide:*` requests come from rules in code, not from the agent. The rule supplies option descriptions and its `reason` serves as the rationale. The agent does not take part.
- Gates with a proposer (`initiative_propose`, `new_dependency`): the briefing is optional; they already carry their drafts.

**Goals.** A reviewer can decide from the request alone, on either adapter, and understands why the agent recommends what it recommends.

**Non-goals.** A rich custom TUI dialog (tabs, previews, notes); that is the follow-up change `rich-approver-dialog`. No change to the forge command grammar, the answer validation, or the gate outcome rules.

**Anti-goals.** The briefing must never become an answer, never hide or soften a failing check, and never let agent text pose as a livespec marker or a `/livespec` command.

**Existing requirements this change alters.**
- approver-adapters "Approver contract": a request also carries a briefing; options carry descriptions; a request may name a recommended option.
- approver-adapters "In-session adapter": the dialog shows the briefing and option descriptions (still only `select`/`input`).
- approver-adapters "Forge adapter request": the plain text below the yaml gets the new structure; the yaml also stores the briefing.
- phase-gates "Gate tool": a human gate refuses without a briefing. ("Gate review payload" itself does not change; showing the payload before the briefing is specified in the new request-briefing capability.)
- questions-and-stuck "Question tool" and "Stuck reports": candidate answers, option descriptions, rationale.
- decision-seam "Decision seam": an `ask` carries option descriptions and the rule's reason as rationale.

Unchanged and relied upon: "An answer MUST come only from the human through the adapter" (approver-adapters), the forge command grammar, superseding at completion (phase-gates "Gate comment").

## Alternatives Considered

### Alternative A: Facts only, better formatting
- **Approach**: Keep the agent out of requests; only restyle the payload and the forge comment.
- **Pros**: No new tool parameters; no untrusted text in requests.
- **Cons**: The reviewer still gets no recommendation or reasoning, which is the user's main ask.
- **Why not chosen**: Solves readability but not "the agent proposes, explains, the human approves".

### Alternative B: Agent asks through `ask_user_question` (rpiv)
- **Approach**: The agent calls `rpiv-ask-user-question` directly and reports the choice back.
- **Pros**: Rich UI immediately.
- **Cons**: The answer would pass through the model, which approver-adapters forbids ("MUST NOT use `ask_user_question`"); adds an external dependency.
- **Why not chosen**: Breaks the core invariant that answers come only from the human through livespec.

### Alternative C: Briefing plus rich dialog in one change
- **Approach**: Ship the briefing, the forge rewrite and a `ctx.ui.custom` dialog together.
- **Pros**: One release delivers the whole experience.
- **Cons**: Large change touching data, tools, forge rendering and TUI at once; the forge side gains nothing from waiting for the TUI.
- **Why not chosen**: Splitting lets the briefing benefit both adapters now and keeps each change reviewable.

## Agreed Approach

A two-layer request: **facts** computed by livespec plus a **briefing** written by the agent (or the rule, for `decide`), rendered for both adapters, with the in-session dialog only lightly improved. The rich dialog modelled on rpiv (option descriptions, preview pane, notes, submit review) follows as `rich-approver-dialog`, owned by livespec through `ctx.ui.custom`, with the `select`/`input` flow as fallback. This won over A because it delivers the recommendation and reasoning, over B because it keeps the answer path, and over C because it is smaller and helps forge users immediately.

## Key Decisions

- Briefings apply to every request kind: gate, amendment, question, stuck and decide.
- The briefing is required for a human gate requested through `spec_gate`; optional for self gates and for gates with a proposer.
- Questions may carry agent-proposed candidate answers; free text stays available.
- `decide` briefings come from the rule, never from the agent.
- The briefing is untrusted text: shown after the facts, labelled agent-authored and advisory, neutralised so it cannot form a marker comment or a line that starts a `/livespec` command, and stored in the request record so the answer shows what the human saw.
- The recommended option must be one of the offered options.
- Forge comments stay in English (public repository content); the command grammar and parser are unchanged.
- The rich TUI dialog is out of scope; it is the follow-up change `rich-approver-dialog`.

## Open Questions

- Length limits for summary, rationale and option descriptions (left to design; the forge comment and the dialog title must stay readable).
- Whether `/livespec next` or the phase card should also show the pending request's recommendation (left to design; default: no).
