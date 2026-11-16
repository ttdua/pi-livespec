## Design Summary

LS-05 ([issue #5](https://github.com/ttdua/pi-livespec/issues/5)) adds human approval and decision points to the livespec flow. It closes two failure modes:

- **The agent approves its own work.** Only an answer that a human gave through an approver adapter can open a human gate. The agent has no tool path that writes a gate, and it cannot relay a fake answer.
- **The agent rates its own work.** `Difficulty` and `Tags` choose which reviewers and skills run, so code decides them from facts ([ADR 0006](../../../docs/decisions/0006-rule-based-decisions.md)).

### Intent and goals

- An `Approver` interface. Its request kinds are `gate`, `question` and `stuck`, its modes are `blocking` and `async`, and its answers are `answered` or `pending`. `poll(requestId)` resolves pending answers.
- Two adapters in v1:
  - **In-session**, built in and always first. It asks the human through pi's own UI (`ctx.ui.select`, `confirm` and `input`), called by extension code. Probe (j) showed that the value returned there is exactly what the human did, and that no model turn is involved. Without an interactive UI (`hasUI` false), this adapter cannot answer, and the next adapter in the list is used.
  - **Forge.** It posts a plain comment that asks for a decision and lists the options, then returns `pending`. A human answers with a `/livespec …` command comment. The answer counts only when `getPermission(author)` is `write` or `admin`. Pending requests are polled at `session_start`, on `/livespec next` and before every livespec tool runs, and the phase card shows what is pending.
- `interaction.adapter` in user or project config is an ordered fallback list. When it is not set, in-session is used. Doctor reports which adapter is in use.
- `spec_gate` with `registerGate`, plus the per-phase gates of the issue table: `self` for shape and review, `human` for define, plan and ship, and none for build. Waivable failing checks are offered as options. Checks that are not waivable, and open blocking questions, keep the gate closed. Whatever adapter answered, the plugin writes the `gate` comment itself and then calls `advancePhase`, except at ship (see Key Decisions). `changes_requested` marks later phases stale. `dismissed` stops the flow and asks the human how to proceed.
- `plan_units` is the only writer of `## Units`. It merges the integration branch and sets `Base`, runs the `difficulty` and `tags` rules, writes the units and posts one decision record per unit. Plan approval locks each unit's digest. A unit whose digest no longer matches the lock is frozen, including after an edit on the web. `unit_amend` (edit, `--add`, `--drop`) needs a light gate that shows only the affected units.
- `spec_question` adds Questions, blocking by default. When answering, the human can change the class and say whether the answer changes a requirement. **Cascade:** the change returns to define, units that cover the requirement are marked stale, and finished stale units are unticked. Returns to define after plan approval count toward `change_iterations`, and at the cap the flow sends a stuck report.
- `spec_stuck` writes a stuck report and waits for a human to pick an option.
- `decide(point, facts)`, the rule registry `registerRule(point, schema, fn)`, decision records (a `decision` comment, or a marked block in a small-fix PR body), and the `tags` and `difficulty` rules with the defaults from the issue.

### Non-goals

- The Plannotator adapter and any third-party approver seam over `pi.events`. Plannotator is not related to this spec.
- `rpiv-ask-user-question` as an approval channel. Probe (j) found that another extension on the same event bus can settle its answer, so it cannot guarantee that the answer came from a human. This changes the issue text, which allowed it once probe (j) confirmed it.
- Rules other than `tags` and `difficulty`, running `Verify`, the `tool_call` guard on direct forge writes (LS-06), and the small-fix lane tool that writes a PR-body record (LS-09; this spec only defines the format).

### Anti-goals (failure even if it "works")

- Any path where text the model produced becomes an approval: a tool parameter, a relayed chat message, or a marked comment written by another account.
- A gate comment or a decision outcome written by anything other than a livespec tool after an approver answer or a rule.
- An agent that can remove a rule-assigned tag or lower the difficulty.

### Existing requirements this change touches

- **forge-markers / Core kinds and registration.** `gate`, `amendment`, `decision`, `question`, `stale` and `stuck` are already core kinds. The new kind for a pending approver request is added through `registerKind`. No requirement changes.
- **forge-markers / Only own marked comments count.** This is unchanged. Forge command comments are **plain** comments and human input, accepted by `getPermission`, never as state. State is always the plugin's own marked comment.
- **flow-engine / Next step precedence.** "Open blocking question" already comes before the gate. LS-05 adds pending approver requests and frozen units to what the card and next step report. This **modifies** the requirement, which will be stated in the delta.
- **flow-engine / Advance phase.** It is reused unchanged by gates and cascade (a backward move to define is already allowed).
- **flow-pack / Registration hooks.** The `decisions` key gets its registered sub-schema here, so the default pack's `decisions: {}` is filled with the `tags` and `difficulty` config.
- **change-issue-format / Questions parsing, Unit digest, Tick and untick units.** These are consumed as specified. Writing an answer must keep the ` — Answer: ` form so the parser reads it back.
- **change-tools / Spec write tool.** It already refuses `Units` and points to `plan_units`. This is unchanged.
- **init-and-doctor / Config files, Doctor checks.** These are **modified**: a new `interaction.adapter` config key, and a doctor line that reports the adapter in use.
- **context-injection / Phase card content.** This is **modified**: the card shows pending approver requests and frozen units.

## Alternatives Considered

### Alternative A: Gate completed in two steps, pending requests stored on the issue
- **Approach**: `spec_gate` runs the checks and then the adapter chain. In-session answers right away inside the tool. Forge posts the request with the plugin's own marked `request` comment and returns `pending`. A later poll reads command comments posted after the request, checks permission, and then completes the same step: it writes the `gate` comment and advances the phase.
- **Pros**: one flow serves gates, questions, stuck reports and amendments, and it survives across sessions. In-session and forge answers produce the same gate record, and the forge stays the source of truth (ADR 0002).
- **Cons**: it needs a new marker kind and a completion step for pending requests.

### Alternative B: Pending requests kept only in session memory
- **Approach**: the same adapters, but the pending request lives in the running session.
- **Pros**: smaller, with no new marker kind.
- **Cons**: closing the session loses the request, and forge answers usually arrive hours later.
- **Why not chosen**: it makes the forge adapter close to useless, and it breaks "the issue is the source of truth".

### Alternative C: Gates opened only by a human-typed slash command
- **Approach**: no approver inside tools. The human types `/livespec approve` in pi.
- **Pros**: the strongest protection against relay in an interactive session.
- **Cons**: no forge or async answers, no print or JSON mode, and it departs from the `Approver` interface in the issue.
- **Why not chosen**: it cannot meet the forge-adapter and polling requirements.

## Agreed Approach

Alternative A, chosen by the user. Pending approver requests live on the change issue as the plugin's own marked comments. In-session answers synchronously. Forge answers through polling. Whichever adapter answers, the same completion step writes the marked result comment (`gate`, `question`, `stuck` or `amendment`) and applies its effect.

## Key Decisions

- **Adapters in v1: in-session and forge only** (user decision). Plannotator is out of scope, including any `pi.events` seam.
- **In-session uses only `ctx.ui.*`.** `rpiv-ask-user-question` is excluded because probe (j) showed another extension can settle it. This changes the issue text.
- **Pending requests are stored on the issue** (Alternative A, user decision).
- **A forge command comment from the plugin's own login is accepted** (user decision, recommended option). The person running pi and the plugin's account are usually the same login, so refusing that login would make the forge adapter unusable for solo users. The known gap: before LS-06, the agent could post `/livespec approve` itself through `gh`/`tea` in bash. The `gate` comment therefore records the answering comment's id and author for audit. The spec states that blocking agent-posted commands depends on LS-06's guard against direct forge writes, which LS-06 must cover (`gh`, `tea` and raw API calls in bash).
- **Re-planning after the lock goes through `unit_amend` only** (user decision). After the first lock, `plan_units` refuses to write. Every unit change after that, including the ones a cascade or `changes_requested` requires, is a `unit_amend` with a light gate. When the plan gate is approved again after a cascade, it re-locks the digests of every existing unit. The plan gate stays closed while any unit is `stale`, or frozen and not amended. Ticks and receipts of units that did not change are kept.
- **A flow-pack override that lowers a gate is a known gap until LS-06** (user decision). `.pi/livespec/flow.yaml` can still set `define`, `plan` or `ship` to `gate: self`, and the agent can edit that file. LS-05 keeps the flow-pack "Project override" requirement unchanged. LS-06 must add a guard that blocks agent writes to `.pi/livespec/`.
- **In-session counts as available when `ctx.hasUI` is true, in both TUI and RPC modes** (builder call). An RPC client is a front end that a human drives, and the model cannot answer its dialogs. A driver with no human behind it is the operator's responsibility. Print and JSON modes have no UI, so they fall back to the next adapter.
- **Human overrides of `Difficulty` and `Tags` at the plan gate** (builder call). An approver answer gains optional `overrides`.
  - In-session: after choosing approve, the human is asked whether to adjust them.
  - Forge: a `/livespec set U<n> difficulty <v>` or `/livespec set U<n> tags <list>` command, posted before `approve`.
  - Each override is written to the unit and recorded as `overridden_by` in its decision record.
- **Approving the ship gate does not move the phase** (builder call). It only writes the `gate` comment. LS-09's `change_ship` needs an approved ship gate, and it moves the change to `close`.
- **The default tag map is the one in the issue**, kept as is and marked "not confirmed for target projects".
- **The pack's `decisions` sub-schema** accepts only `mode: rule`. `mode: jev` is rejected in v1 (ADR 0006).

## Open Questions

- Whether the default tag map fits the target projects is still not confirmed. It is not blocking, and it will be revisited with decision-record data (roadmap, "After v1").
- The exact grammar and edge cases of forge command comments (quoting, several commands in one comment, edited comments) are left to design.
