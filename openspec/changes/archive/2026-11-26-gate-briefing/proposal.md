## Why

Human decisions reach the reviewer as raw facts: a joined text block in a chain of `select` dialogs, or a forge `request` comment that reads like a log followed by the full `/livespec` grammar. Nothing says what the change does, what to look at, which answer fits or why. The agent holds that context, so it should prepare each decision with options, a recommendation and its reasoning, while the answer still comes only from the human.

## What Changes

**Request content**
- From: a request carries a summary of facts and options as `{id, label}`.
- To: a request also carries a `briefing` (summary, points to watch, recommended option, rationale), and each option may carry a `description`. The briefing is stored in the request record and shown after the facts, labelled agent-authored and advisory, with marker comments and `/livespec` command lines neutralised.
- Reason: the reviewer needs the agent's recommendation and its reasoning, without trusting it as fact.
- Impact: non-breaking for stored requests (the field is optional when read).

**`spec_gate` and `unit_amend`**
- From: `spec_gate` takes only `target`; `unit_amend` takes the unit contract.
- To: both accept a `briefing` parameter. `spec_gate` refuses a human gate without one; it is optional for self gates. Gates with a proposer accept an optional briefing through their proposer tool.
- Reason: a recommendation is only useful if it is always there when a human decides.
- Impact: breaking for agents that call `spec_gate` on a human gate without a briefing; the tool descriptions and the refusal text teach the new parameter.

**`spec_stuck`**
- From: options `{id, label}` and a `recommended` id.
- To: each option requires a `description`, and a `rationale` explains the recommendation.
- Impact: breaking parameter change for `spec_stuck`.

**`spec_question`**
- From: a question is one line of text; the human types the answer.
- To: the agent may add 2-4 candidate answers with descriptions and a recommended one with rationale. The human picks one or writes their own; on the forge each candidate is a ready-to-copy `/livespec answer Q<n> …` command. The command grammar is unchanged.

**Rule asks (`decide`)**
- From: a rule's `ask` has a summary and `{id, label}` options.
- To: a rule may give option descriptions, a recommended option and a rationale. The agent takes no part.

**Rendering**
- Forge `request` comment: markdown with a "Decision needed" heading, the recommendation, what is being decided, a checks table, a short "How to answer" table and the full command list folded away. The marker yaml and the parser do not change.
- In-session dialog: the briefing is shown before the options, and options are labelled with their description, the recommended one marked "(Recommended)". Still only `select` and `input`.

Out of scope: a rich custom TUI dialog (follow-up change `rich-approver-dialog`).

## Capabilities

### New Capabilities
- `request-briefing`: the briefing attached to every human request, its validation, its untrusted-text handling and its rendering for both adapters.

### Modified Capabilities
- `approver-adapters`: "Approver contract" (request carries a briefing, option descriptions), "In-session adapter" (dialog shows the briefing and descriptions), "Forge adapter request" (new plain-text structure, briefing in the yaml).
- `phase-gates`: "Gate tool" (`briefing` parameter; human gate refuses without one).
- `questions-and-stuck`: "Question tool" (candidate answers), "Stuck reports" (option descriptions, rationale).
- `decision-seam`: "Decision seam" (an `ask` may carry option descriptions, a recommended option and a rationale).
- `unit-planning`: "Unit amendments" (`unit_amend` accepts a briefing).

## Impact

- Code: `src/interaction/approver.ts`, `in-session.ts`, `forge.ts`, `requests.ts`; `src/tools/spec-gate.ts`, `unit-amend.ts`, `spec-stuck.ts`, `spec-question.ts`, `decide-ask.ts`; `src/decide/registry.ts`, `seam.ts`; `src/docs/behavior-change.ts`; `src/tools/initiative-propose.ts`, `new-dependency.ts` (optional briefing); `src/subagents/finish-freshness.ts` (the stuck report livespec builds itself); README "Human gates" section. The external agent-skills content is not part of this repository and is not changed.
- Public API: tool parameters of `spec_gate`, `unit_amend`, `spec_stuck` and `spec_question`.
- No new dependency, no forge command grammar change, no change to answer validation or gate outcomes.
