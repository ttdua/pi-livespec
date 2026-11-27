# pi-livespec

**English** | [Tiếng Việt](README.vi.md)

A [pi](https://github.com/earendil-works/pi) extension that keeps a coding agent on a spec-driven workflow it cannot skip. Each change lives on a forge issue (GitHub or Gitea), the living spec lives in your repository under `specs/`, and every phase ends at a gate that only a human, or a passing check, can open.

> **Status: v0.2.0.** Every roadmap spec up to LS-10 is built, plus request briefings and the in-session dialog. The dogfood comparison with pi-superspec ([LS-11](https://github.com/ttdua/pi-livespec/issues/11)) is still in progress. See the [changelog](CHANGELOG.md).

**This README covers:** what livespec does, how to install and set it up, and how to run each workflow step by step, including what you read and answer at every human gate. It assumes you already use pi and git. Deep internals are in [Architecture](docs/architecture.md).

## Contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Install and set up a project](#install-and-set-up-a-project)
- [How you work with livespec](#how-you-work-with-livespec)
- [Workflow 1: a full change](#workflow-1-a-full-change)
- [Human gates: what to read and how to answer](#human-gates-what-to-read-and-how-to-answer)
- [Workflow 2: a small fix](#workflow-2-a-small-fix)
- [Workflow 3: an initiative of several changes](#workflow-3-an-initiative-of-several-changes)
- [Workflow 4: a dependency found mid-build](#workflow-4-a-dependency-found-mid-build)
- [Workflow 5: drift audit](#workflow-5-drift-audit)
- [Migrating from OpenSpec](#migrating-from-openspec)
- [Optional: subagents and parallel lanes](#optional-subagents-and-parallel-lanes)
- [Reference](#reference)
- [Troubleshooting](#troubleshooting)

## What it does

In long sessions agents forget steps: they skip verification or review, lose state, or declare work done without proof. A skill that only *asks* the agent to behave does not stop this. livespec moves the workflow into the extension:

- **The extension owns the flow.** A flow pack (YAML) defines the phases `shape → define → plan → build → review → ship → close`. livespec computes the next step, shows it on a **phase card** every turn, and refuses tools the state does not allow.
- **The change lives on an issue.** The issue body holds the proposal, design, questions and units. Tool-written comments hold receipts, gate decisions and review findings. Each change ships as exactly one pull request.
- **The living spec lives in the repo.** `specs/<capability>/spec.md` is edited in place on the change branch, so the spec delta is part of the pull request diff.
- **Evidence is collected by the extension, not claimed by the agent.** Each unit has one `Verify` command. livespec runs it, requires it to fail before the work and pass after, and posts a receipt. Only livespec ticks a unit done.
- **Humans approve gates.** Approvals, questions and stuck reports reach you through a dialog in pi or a comment on the issue. No tool takes an "approved" parameter, so the agent cannot approve its own work.
- **Guards block the shortcuts.** Direct `git push`, direct forge writes (`gh`, `tea`, `curl` to the forge) and edits to `.pi/livespec/` are blocked; livespec tools push only after checking the state.

The method comes from [agent-skills](https://github.com/addyosmani/agent-skills): livespec loads the skill that matches each phase. Ideas are borrowed from [OpenSpec](https://github.com/Fission-AI/OpenSpec), litespec and [pi-superspec](https://github.com/ttdua/pi-superspec).

## Requirements

**Required**

| Tool | Why | Check |
|---|---|---|
| [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`) | livespec is a pi extension | `pi --version` |
| `git` | branches, worktrees, receipts. 2.38 or later is recommended: older git disables the clean-merge exception at ship and the precise empty-fix check | `git --version` |
| A git remote named `origin` on GitHub or Gitea | livespec reads the forge from it | `git remote -v` |
| **GitHub:** [`gh`](https://cli.github.com/) logged in with write access to the repo | issues, comments, pull requests | `gh auth status` |
| **Gitea:** a `tea` login for the server, or `GITEA_TOKEN` in the environment | livespec reads the token from the `tea` config; it never runs `tea` | `tea login list` |
| A project test command | the small-fix lane runs it before it ships (`testCommand`) | — |

**Optional** (each has a fallback)

| Package | Adds | Without it |
|---|---|---|
| [`@ttdua/pi-subagents`](https://github.com/ttdua/pi-subagents) ≥ 0.1.1 | scout, implementer, reviewer and verifier children; parallel lanes | every role runs inline in your session and leaves the same evidence |
| [pi-jev-pilot](https://github.com/ttdua/pi-jev-pilot) ≥ 0.6.0 | model routing for children | the role's agent file and your pi settings choose the model |
| Forge approver (`interaction.adapter: [forge]`) | answer gates by commenting on the issue, from anywhere | gates are answered in pi dialogs (`in-session`, the default) |

## Install and set up a project

Do this once per machine (steps 1–2) and once per repository (steps 3–7).

1. **Install the extension.**

   ```sh
   pi install git:github.com/ttdua/pi-livespec@v0.2.0
   ```

   Drop `@v0.2.0` to track `main` instead of the release.

2. **Log in to your forge** with an account that can write to the repository.

   ```sh
   gh auth login                 # GitHub
   tea login add                 # Gitea (or export GITEA_TOKEN=...)
   ```

3. **Open pi in the repository** on its integration branch (usually `main`), with a clean tree.

   ```sh
   cd my-project && pi
   ```

   An uninitialized project shows no phase card. pi suggests `/livespec init` (or `/livespec migrate-openspec` when an `openspec/` folder exists; see [Migrating from OpenSpec](#migrating-from-openspec)).

4. **Initialize livespec.**

   ```text
   /livespec init
   /reload
   ```

   `init` creates only what is missing, so it is safe to rerun:

   ```text
   specs/product.md          what the product is, who it serves
   specs/glossary.md         shared terms, one per line
   specs/constraints.md      the quality bar every change respects
   specs/decisions/          decision records
   .pi/livespec/config.yaml  project config, every key commented out
   ```

   It also clones agent-skills into `~/.pi/agent/livespec/agent-skills/` (shared by all projects).

5. **Set the project config.** Edit `.pi/livespec/config.yaml`. At minimum, set the test command; set the forge only when detection from `origin` fails (self-hosted servers):

   ```yaml
   testCommand: bun test           # run by fix_ship; must exit 0
   # forge: gitea
   # giteaUrl: https://gitea.example.com
   # integrationBranch: main
   ```

   All keys are listed under [Configuration](#configuration).

6. **Draft the durable docs.** Until `specs/constraints.md` is drafted, the phase card asks the agent to draft it with the `constraint-driven-development` skill. Ask the agent to do it, then review and edit `specs/product.md` and `specs/constraints.md` yourself: every later phase reads them. Remove the template marker line at the top of `constraints.md` when it is done.

7. **Check the setup and commit it.**

   ```text
   /livespec doctor
   /livespec validate
   ```

   Doctor must report no `error`. It names the forge account it will write as, the approver chain and the adapter that will answer now, the agent-skills commit and any conflicting package. Then commit `specs/` and `.pi/livespec/` to the integration branch.

   > **Superpowers or pi-superspec active?** Doctor warns that Superpowers competes with the livespec flow. Disable it for this project so the agent follows only the phase card.

## How you work with livespec

You talk to the agent as usual. livespec adds three things the agent and you both rely on:

- **The phase card.** Every turn the agent sees the change, the phase, counters, failing checks and **one next step**. Ask "what's next?" or run `/livespec next` to see the same sentence yourself.
- **livespec tools.** The agent calls tools such as `change_new`, `spec_gate` or `unit_finish`. You never need to type tool calls; ask in plain language ("start a change for X", "request the define gate", "ship it"). When a next step says *a human runs X*, livespec expects **you** to tell the agent to do it.
- **Requests that wait for you.** Gates, questions, stuck reports and some decisions wait for a human answer. With the default `in-session` adapter they appear as one pi dialog per request during the tool call; with the `forge` adapter they appear as a comment on the issue that you answer with a `/livespec …` comment.

**Rule of thumb:** when the agent stops and the card says "Wait for the human's answer to …", it is your turn. Everything else the agent can do on its own.

## Workflow 1: a full change

Use this for any change that adds or changes behavior. One change = one issue = one branch `livespec/<name>` = one pull request.

| Phase | Who acts | Ends with |
|---|---|---|
| `shape` | agent interviews you | self gate (checks only) |
| `define` | agent writes the proposal and the spec delta | **human gate** |
| `plan` | agent splits the work into units | self gate, **human** when it escalates |
| `build` | agent (or implementer children) builds unit by unit | every unit ticked with a receipt |
| `review` | reviewers, verifier, agent fixes | self gate (`review-clean`) |
| `ship` | agent fills the durable docs table and opens the PR | **human gate**, then `change_ship` |
| `close` | you merge the PR; agent closes the issue | `change_close` |

### 1. Shape: say what you want

Tell the agent the intent in plain words:

```text
Start a livespec change: limit each client IP to 100 requests per minute.
```

The agent runs `change_new <name>` (a kebab-case name such as `per-ip-cap`), which creates the issue with labels `livespec` and `livespec:phase/shape`. It then interviews you with the `interview-me` skill. **Answer its questions in chat**: scope, users, edge cases, what is out of scope. If the work is too big for one change, the card suggests an initiative ([Workflow 3](#workflow-3-an-initiative-of-several-changes)).

The shape gate is a `self` gate: when the agent runs `spec_gate shape` and the checks pass, the change moves to `define` with no question to you.

### 2. Start the branch

Once the change is past `shape`, the card says `Run change_start #<n>`. The agent fetches the integration branch and creates `livespec/<name>` from it, recording `Branch` and `Base` in the issue. It never pushes. Start from a clean tree.

### 3. Define: proposal and spec

The agent writes, through `spec_write`, the `Capabilities`, `Product impact`, `Proposal` and `Design` of the issue, and edits `specs/<capability>/spec.md` on the branch (requirements with SHALL/MUST and WHEN/THEN scenarios). A spec reviewer may run as advice. When the checks pass, it requests the **define gate**: see [Define gate](#define-gate-is-this-the-right-behavior).

Questions the agent cannot answer itself become `spec_question` requests ([Question](#question-answer-what-the-agent-cannot-know)). A blocking question keeps every gate closed until you answer.

### 4. Plan: units

The agent writes the `## Units` section with `plan_units`. Each unit looks like this:

```markdown
### U3 — Rate limit per IP
Covers: rate-limit/Requirement: Per-IP cap
Difficulty: medium
Tags: [security, api]
Files: src/middleware/ratelimit.ts, test/ratelimit.test.ts
Done means:
- [cap] the 101st request within 60 s from one IP gets 429
Scenarios:
- [cap] test/ratelimit.test.ts › rejects 101st request
Depends: U1
Verify: `bun test ratelimit`
- [ ] pending
```

`Difficulty` and `Tags` are set by rules, not by the agent. Before the gate, livespec runs every unit's `Verify` on `Base` in a temporary worktree (`verify-red-on-base`): a normal unit must fail there, which proves the test checks something new. Then it requests the **plan gate**: see [Plan gate](#plan-gate-is-this-the-right-way-to-build-it). Approval **locks** each unit's digest; later edits to a unit need `unit_amend` and your approval.

### 5. Build: one unit at a time

For each ready unit the card says `Build U<n>`. The loop is:

1. `unit_start U<n>` checks the tree is clean and dependencies are done, runs `Verify` and posts a `unit-start` receipt. `Verify` must be **red**.
2. The agent (or an implementer child) writes the test and code within the unit's `Files` and commits.
3. `unit_finish U<n>` runs `Verify` again. When it is **green**, livespec posts a receipt with both SHAs and exit codes and ticks the unit.

You do nothing here unless something waits for you:

- **A failed attempt** is counted. After `loops.unit_attempts` (3) failures, or two identical failures in a row, the unit is `BLOCKED` and the agent sends a **stuck report** ([Stuck report](#stuck-report-pick-a-way-out)).
- **A unit must change** (wrong `Files`, missing scenario) → the agent calls `unit_amend`, which sends you an **amendment** request, answered like a plan gate.
- **The agent needs work outside the change** → [Workflow 4](#workflow-4-a-dependency-found-mid-build).

When the session tries to end with a started unit or a dirty tree, livespec asks the agent to continue once, then records an `incomplete` comment on the issue.

### 6. Review

The agent runs `spec_review`. It runs every `Verify` at `HEAD`, launches reviewers (the whole-change reviewer always; security, performance and test personas by tags), merges their findings, sends findings to a verifier, and routes each one:

- a finding in a unit's `Files` unticks that unit and returns the change to `build`;
- a finding that needs your decision becomes a question;
- an out-of-scope finding never blocks; it is listed for you at the ship gate as a follow-up;
- lowered standards (an added `skip`/`only`, `@ts-ignore`, a deleted test) are always CRITICAL.

The review gate is `self`: it passes when the latest round ran at the current `HEAD` and left no blocking finding. After `loops.review_rounds` (3) rounds with blocking findings, a stuck report comes to you.

### 7. Ship

The agent fills the `## Durable docs` table with `docs_table` (which of `spec.md`, `product.md`, `glossary.md`, `constraints.md`, `decisions/` were updated, and why the others were not needed), then requests the **ship gate**: see [Ship gate](#ship-gate-is-this-ready-to-publish).

After you approve, the agent runs `change_ship`. It pushes the reviewed commit and opens one pull request that says `Refs #<issue>`. It never writes a closing keyword, so the forge does not close the issue on merge.

**Feedback on the pull request.** Review comments from people with write access and failing CI checks are pulled in automatically at session start and on `/livespec next`. They move the change back to `review`; the agent fixes them on the same branch, the review gate passes again, and `change_push` updates the pull request. If the fix touches `specs/`, the ship gate is asked again.

### 8. Close

**You merge the pull request on the forge.** livespec never merges. On the next refresh the card says to move to `close`, and the agent runs `change_close`: it posts a summary, ticks the change in its initiative (if any) and closes the issue.

To abandon a change instead, close its pull request without merging and ask the agent to run `change_close --abandon <reason>`. (A change dropped through option D of [Workflow 4](#workflow-4-a-dependency-found-mid-build) can be abandoned without a pull request.)

## Human gates: what to read and how to answer

Every human decision follows the same lifecycle: the agent asks, **you** answer, livespec records the result on the issue. The agent cannot answer for you; a message from the agent that says "approved" changes nothing.

### Where the request appears

| Adapter | When it is used | What you see | How you answer |
|---|---|---|---|
| `in-session` (default) | pi has a UI (`hasUI`) | one dialog per request in the pi TUI; select prompts in RPC hosts and other modes | pick an option and submit it on **Review**; Esc counts as **dismiss** |
| `forge` | the forge is connected and writable | a `request` comment on the change issue | post a new comment whose **first line** is a `/livespec …` command |

Choose the order in `interaction.adapter` (for example `[in-session, forge]`: dialogs while you are at the keyboard, the issue otherwise, and in print mode). `/livespec doctor` shows which adapter would answer now.

### Answering in session

The dialog title is the request summary (the facts), then the briefing (see [The briefing](#the-briefing-and-the-recommendation)). Each menu entry reads `<label> — <description>`; the recommended entry comes first and ends with ` (Recommended)`. For a gate the menu offers:

1. **approve** (hidden while a waivable check fails; use `waive` then);
2. **request changes**, then type what must change;
3. **dismiss**;
4. any extra options, for example `waive`, with their descriptions.

A question offers its 2 to 4 candidate answers, **write my own answer** and **answer later (non-blocking)**. Picking a candidate answers with its label as the text.

In the pi TUI the request is one dialog with the tabs **Decision** and **Review**. **Adjust units** opens with `u` on Decision, at the plan gate and for amendments, when units can be overridden. Notes are written inside it with `n`, and nothing is sent until you submit on **Review**. **answer later** and **dismiss** end the dialog at once, without Review.

In RPC hosts and other modes the same answers come from select prompts: after approve or an option you choose **No notes** or **Add notes**, and at the plan gate and for amendments **Keep classification** or **Adjust Difficulty or Tags**.

**Dialog keys** (TUI):

- `↑` `↓` move; `1`–`9` pick the entry with that number.
- `n` write a note.
- `u` open **Adjust units** (Decision, when units can be overridden).
- `Tab` / `Shift+Tab` next / previous tab.
- `←` / `→` change Difficulty; `e` edit tags (Adjust units).
- `PgUp` / `PgDn` scroll the facts and briefing.
- `Enter` pick (Decision), next tab (Adjust units), submit (Review); in an open editor, save it.
- `Esc` cancel the request (`dismissed`); with an editor open, close only the editor.

### The briefing and the recommendation

Every human request carries a **briefing** next to the facts: a short summary, up to five watch points, a recommended choice and the reason for it. Read it as advice, not as evidence:

- **Facts come first.** The summary, files, links and failing checks are written by livespec. The briefing follows and is labelled `Agent recommendation (agent-authored, advisory)`. A rule that asks (`decide:`) carries a briefing written by the rule, labelled `Livespec rule recommendation`.
- **The recommendation is not an answer.** It only marks a choice (first in the menu, `(recommended)` on the forge). Nothing is approved until you pick. A recommendation must name a choice that is actually offered: `approve` is never recommended while a check must be waived.
- **Agent text is inert.** livespec neutralises `<!--` and a leading `/livespec` in it, so the briefing cannot add a command or fake a marker.
- A request written before this feature has no briefing and still works.

`spec_gate` requires a briefing for a human or escalated gate, and `unit_amend`, `initiative_propose` and `new_dependency` require one too; each needs a `recommended` choice and a `rationale`. A `spec_question` requires 2 to 4 candidates with a `recommended` choice and a `rationale`.

### Answering on the forge

Read the `request` comment. It is laid out top to bottom as: a **Decision needed** heading, the facts (summary, files, links), the failing waivable checks as a table, the briefing as a blockquote, a **How to answer** table (choice, what happens, the exact command; the recommended choice is bold with `(recommended)`) and a collapsed **All accepted commands** list. For example (a plan gate where `size-limits` fails):

```markdown
## Decision needed: approve the plan gate on #7

### Review (blocking)

Plan: 9 units, 3 capabilities.

### Failing checks

These waivable checks fail; approving needs `waive`.

| Check |
| --- |
| `size-limits` |

### Agent recommendation (agent-authored, advisory)

> Units are small and each has one Verify command.
>
> Recommended: Waive size-limits
>
> Rationale: the split would not make the units smaller.

### How to answer

Post a new comment whose first line is the command (write access required).

| Choice | What happens | Command |
| --- | --- | --- |
| **Waive size-limits** (recommended) | Approve and waive the failing checks: size-limits. | `/livespec choose waive [notes]` |
| request changes | Send the request back with notes; nothing is approved. | `/livespec changes <notes>` |
| dismiss | Close the request without approving it. | `/livespec dismiss [notes]` |
```

A question's table lists each candidate with the command `/livespec answer Q<n> <label>` plus a row for your own answer. Reply with a **new** comment (editing an old one does nothing):

| Command | Use for |
|---|---|
| `/livespec approve [notes]` | approve a gate or amendment (notes optional) |
| `/livespec changes <notes>` | request changes; notes are required |
| `/livespec dismiss [notes]` | reject without a decision; the agent must ask you how to proceed |
| `/livespec choose <option-id> [notes]` | pick an option: `waive`, a stuck option, `A`/`B`/…, `unchanged`/`changed` |
| `/livespec answer Q<n> <text>` | answer a question in one step; to change a requirement, edit its spec |
| `/livespec set U<n> difficulty <low\|medium\|high>` | override a unit (plan gate and amendments; applied only if the gate is approved) |
| `/livespec set U<n> tags <a,b,…>` | override a unit's tags (same) |

Rules that decide whether your comment counts:

- **Only accounts with `write` or `admin`** on the repository can answer.
- The comment must be **newer than the request**; a command posted earlier is ignored.
- `approve`, `changes` and `choose` target the **single** pending gate or amendment (otherwise the single pending stuck or decide request). If several are pending and the target is ambiguous, the comment is ignored.
- An ignored command stays ignored; the phase card shows why. Post a corrected comment.
- Answers are picked up at session start, on `/livespec next` and before every livespec tool. With no session running, the next session applies them.

### What happens after you answer

| Your answer | Result |
|---|---|
| approve / approve with notes | a `gate` comment is written; the change moves to the next phase (except `ship`, which stays and allows `change_ship`) |
| request changes | the phase stays; later phases are marked stale; the agent revises and asks again |
| dismiss | nothing moves; the agent asks you in chat how to proceed |

**An approval can be superseded.** When the answer is recorded, livespec checks that what you saw is still true: `HEAD` is unchanged, the issue body is unchanged, the tree is clean and no refusal applies. If anything moved (a new commit, a web edit of the proposal, uncommitted files), the answer is recorded as `superseded`, nothing advances, and the agent must request the gate again. Approve only what you reviewed, and do not push or edit the issue between the request and your answer.

### Define gate: is this the right behavior?

**You see:** the `Capabilities` line, the `Product impact` line, the Proposal (or its start with a link), the list and stat of changed files under `specs/`, and glossary warnings plus any glossary entries the diff adds.

**Read:**

1. The **Proposal** on the issue: is the problem and scope what you asked for? Anything missing or out of scope?
2. The **spec diff** (`git diff <Base>..HEAD -- specs/` on the branch): each requirement must be testable, each scenario a concrete WHEN/THEN. These scenarios become tests.
3. **Capabilities**: new vs modified names match the diff.
4. **Product impact**: `updated` or `none — <reason>`. A new capability with `none` is wrong.
5. **Glossary**: new terms are defined; approving the gate approves the glossary entries listed.

**Answer:** approve when the spec says exactly what should be built. Otherwise request changes with concrete notes, for example `/livespec changes split "Per-IP cap" into burst and sustained limits; add a scenario for IPv6`.

**Behavior-change question.** At the define and review gates, livespec may first ask, per capability, whether code changed under that spec's `paths` without a spec edit changes behavior. Choose `unchanged` when it is a refactor; choose `changed` and the gate refuses until the spec is updated.

### Plan gate: is this the right way to build it?

**You see:** each unit's id, title, `Difficulty`, `Tags` and `Covers`, the reason of each classification decision, any tags the agent added, and the `verify-red-on-base` results.

**Gate:** `self` by default: the agent passes the gate alone when its checks pass, unless the `gate-escalation` rule asks you. It asks when a waivable check fails (for example `size-limits`), the advisory plan review at `HEAD` is missing or has a CRITICAL finding, or a unit is tagged `security` or `migration`. The request ends with `Escalated: <reason>` and needs a briefing. To always ask, set `gate: human` on the `plan` phase in `.pi/livespec/flow.yaml` (with `extends: agent-skills`); to change the triggers, set `decisions.gate-escalation` (`phases`, `tags`).

**Read:**

1. **Coverage**: every requirement and scenario from define is covered by some unit (`Covers`, `Scenarios`).
2. **Verify** of each unit: one command that runs the unit's test, red today and green when done. Red-on-base failures mean a test already passes; ask why.
3. **Files**: small and specific. `change_ship` refuses a diff with a file outside every unit's `Files` (and `specs/`), and a lane that strays re-runs sequentially.
4. **Depends** and order: units that can run in parallel share no `Files`.
5. **Difficulty and Tags**: tags drive which reviewers run (`security` adds the security auditor). Override them if they look wrong.
6. **Size**: over 8 units or 3 capabilities fails `size-limits`. Either ask the agent to split (`change_split`) or `choose waive` deliberately.

**Answer:** approve to lock the plan. Override with `/livespec set U3 difficulty high`, with `u` (Adjust units) in the pi TUI, or with the "Adjust Difficulty or Tags" step, then approve. Request changes for missing coverage or a bad `Verify`.

### Ship gate: is this ready to publish?

**You see:** the `## Durable docs` table, and the review result: disputed findings with the verifier's reason, rebutted findings, out-of-scope follow-ups, and the review subjects that ran inline (no independent child checked them).

**Read:**

1. **Durable docs**: each `updated` row names a file in the diff; each `not needed` row has a reason you agree with.
2. **Disputed and rebutted findings**: you are the tie-breaker. If you side with the reviewer, request changes.
3. **Follow-ups**: create issues for out-of-scope findings you want to keep.
4. **The diff itself** on the branch, since the pull request does not exist yet.

**Answer:** approve, then tell the agent to ship. Approval binds to the reviewed `HEAD`; a later commit (other than a clean merge of the integration branch) needs review again.

### Question: answer what the agent cannot know

**You see:** the question text and whether it blocks: `blocking` (gates stay closed) or `non-blocking` (after you choose **answer later** in session), and optionally 2 to 4 **candidate answers** (each a label and a description), possibly one recommended with its reason.

**Answer** by picking a candidate, or with your own text. One step is enough:

```text
/livespec answer Q2 use per-user limits, not per-IP
```

If the answer changes a requirement, edit its `specs/<capability>/spec.md` and commit it on the change's branch; there is no flag. The cascade below runs only after the plan is locked; before that, the edit is simply part of the change. livespec finds the edit from the spec diff at session start, on `/livespec next`, and before the next gate or `unit_finish`. The change goes back to `define` and the done units that cover the requirement are unticked; the counter `change_iterations` rises if the plan was already approved. Edit the spec only when the answer really changes it. "Answer later" in session makes the question non-blocking and passes it to the next adapter.

### Stuck report: pick a way out

**You see:** a `stuck` comment with where the work stopped, what was tried (with links), a hypothesis, two or three options each with a description, and the recommended one with its rationale (both required from the agent).

**Answer:** choose one option (`/livespec choose B`, or pick it in the dialog). A choice restarts the blocked budget (unit attempts, review rounds or iterations). **Dismissing does not lift the cap**; the agent will have to ask again.

### Amendment, decisions and other named gates

- **Amendment (`amend:<n>`):** the agent wants to edit, add or drop a locked unit. Read the old and new unit; answer like the plan gate.
- **Decision (`decide:<point>.<subject>`):** a rule could not decide (for example `behavior-change`). Choose one of the listed options.
- **`initiative` and `new-dependency`:** see Workflows [3](#workflow-3-an-initiative-of-several-changes) and [4](#workflow-4-a-dependency-found-mid-build).

## Workflow 2: a small fix

Use this for a typo, a small bug that restores specified behavior or a tiny refactor. There is no issue, no gate and no unit.

1. **Start:** ask the agent to start a fix, for example "fix the typo in the README as a small fix". It runs `fix_start <slug>` from a clean tree on the integration branch, creating `fix/<slug>`. (A branch you create by hand with that name also counts.)
2. **Edit:** the agent edits code, tests and, if needed, the living spec, and commits.
3. **Lane check:** the card shows the lane outcome after each commit. The fix must stay **small**: at most 3 files and 100 changed lines, no added or removed requirement or scenario, no new capability, no edit to `specs/constraints.md` or `specs/decisions/`.
4. **Ship:** the agent runs `fix_ship`. It runs `testCommand`, refuses unless it exits 0, pushes `fix/<slug>` and opens (or updates) one pull request with the test result and the lane decision.
5. **You review and merge** the pull request on the forge.

**When the fix outgrows the lane**, the card says it is forced into a full change. Ask the agent to run `change_new <name> --from-fix`: the issue is created in `define`, the commits are kept, and the branch is renamed to `livespec/<name>`. Continue with [Workflow 1](#workflow-1-a-full-change) from step 3.

**Bare work.** An edit outside `specs/` on a branch that is neither `livespec/*` nor `fix/*` is allowed, but livespec warns and logs it in `specs/bare-work.md`.

## Workflow 3: an initiative of several changes

Use this when one goal needs several changes that ship separately and depend on each other.

1. **Shape the first change** as usual. When the declared capabilities or drafted units exceed the limits, the card names `initiative_propose`. You can also ask for an initiative directly.
2. **The agent proposes** the initiative: a name, the goal, the capabilities, and the list of changes with a short proposal and their `Depends`. This sends the **`initiative` gate**. Nothing is created yet.
3. **You review the proposal.** Read:
   - is each change independently shippable and reviewable?
   - are the `Depends` right, with no change waiting on something it does not need?
   - is the current change in the right place in the list?

   Approve, or request changes with notes. Cycles and duplicate names are refused before you see them.
4. **On approval** livespec creates the tracking issue (label `livespec:initiative`), the new change issues in `shape`, and links the current change.
5. **Work the changes** one by one with [Workflow 1](#workflow-1-a-full-change). The card lists the initiative's progress and the changes ready to start. A change whose dependency has not merged shows "waits for #A"; once it merges, **you tell the agent** to run `change_start #N`.
6. **Keep branches current.** When a sibling merges, the card asks for `change_sync`: it merges the integration branch, re-runs every done unit's `Verify` and unticks units that regressed or whose requirement the sibling changed.
7. **Closing the last change** closes the initiative with a summary.

To add, edit or drop changes later, ask the agent to amend the initiative; the same `initiative` gate comes to you. To move pending units of a too-big change into a new change: `change_split #N --units U5,U6 --into <name>`.

## Workflow 4: a dependency found mid-build

When an implementer reports that a unit needs work outside the change (`missing-prerequisite`), the card names `new_dependency`. The agent drafts the options and sends the **`new-dependency` gate**:

| Option | Choose when | What follows |
|---|---|---|
| **A** | the prerequisite deserves its own change | a new change in `shape` is created; this change is **parked** |
| **B** | the missing work is small and belongs here | new units via `unit_amend --add` |
| **C** | you can stub it now | a stub unit here and a follow-up change |
| **D** | the change was wrong | back to `shape`, or drop the change |
| **split** | some units are done | ship the done units; the rest go to a new change |

Read the drafted prerequisite (name, proposal) and answer with `/livespec choose A` (or pick it in the dialog).

**After A:**

1. The agent runs `change_park`: started work is committed to wip branches, pushed through livespec, lanes are closed, and the issue gets `livespec:parked`. Gates refuse while parked.
2. Build and merge the prerequisite change.
3. When the card says the dependency merged, **you tell the agent** to run `change_resume #N`. It syncs with the integration branch, merges the wip branches back, deletes them on the remote and lifts the park.

After two approved dependencies (`loops.discovered_deps`), the next one becomes a stuck report.

## Workflow 5: drift audit

Run this periodically, or when the card's **Audit** section says commits landed outside livespec.

1. Run `/livespec audit` (or `/livespec audit #T` to post on initiative `#T`). It reads `origin/<integration>`, changes no file and creates nothing but a `drift-report` comment.
2. Read the report. Items are `major` (route: a full change) or `minor` (route: a small fix): untested scenarios, references to removed code, dead `paths` globs, unused glossary terms, stale decisions, capabilities missing from `product.md`, and fixes that declared no behavior change.
3. Triage on the initiative with a comment per item: `/livespec triage <key> major|minor|ignore`. The next audit applies it.
4. Fix the items with [Workflow 2](#workflow-2-a-small-fix) or [Workflow 1](#workflow-1-a-full-change).

## Migrating from OpenSpec

1. Finish or archive open OpenSpec changes first; only living specs move.
2. On the integration branch with a clean tree, run `/livespec migrate-openspec`. It `git mv`s each `openspec/specs/<cap>/spec.md` to `specs/<cap>/spec.md` without changing content. Nothing else under `openspec/` moves. It refuses, moving nothing, if any target already exists.
3. Run `/livespec init` for the files that are still missing, then `/livespec validate`.
4. Commit. Remove `openspec/` yourself when you no longer need its history, and disable pi-superspec or Superpowers for the project.

## Optional: subagents and parallel lanes

livespec can hand role work (`scout`, `implementer`, `reviewer`, `verifier`) to subagent children and run independent units in parallel lanes. The parent session keeps all state, evidence, forge writes and gates. Without an executor every role runs inline (`subagent_packet` / `subagent_record`) and leaves the same evidence. See [Architecture: Subagents](docs/architecture.md#subagents).

**Install the executor**, then optionally Jev model routing:

```sh
pi install git:github.com/ttdua/pi-subagents@v0.1.1
pi install git:github.com/ttdua/pi-jev-pilot   # 0.6.0 or later, after the executor
```

livespec detects the executor by capability (`spawn`, `wait`, `resume`, `abort`, `childSession`, `getAgentType`), never by package name. `/livespec doctor` reports it, any missing capability and any overridden role agent.

- **Model and effort.** livespec never sets a model. It requests a thinking level from the unit's `Difficulty`, raised one level per failed attempt. With Jev, pi-jev-pilot routes the model; without it, the role's agent file and your pi settings decide. Each `dispatch` record stores what was requested and what ran.
- **Role guidance.** Give `reviewer` and `verifier` strong models: their findings gate `unit_finish`. `scout` only reads, so a cheap model is fine. Override a role with an agent file of the same name, for example `~/.pi/agent/agents/reviewer.md`.
- **Lanes.** Ready units with no `Depends` between them and disjoint `Files` run in worktrees `.worktrees/<change>--<unit>` (`lane_open`), up to `lanes` (3). `lane_merge` merges each back and re-runs `Verify`. A lane that touched files outside its unit re-runs sequentially.
- **Findings.** A blocking review finding refuses `unit_finish` until it is fixed, rebutted with `finding_rebut` or, for `needs-decision`, answered. Out-of-scope findings never block; they are listed at the next human gate.
- **Workspace providers.** `@gotgenes/pi-subagents-worktrees` moves children out of their lane. Remove `npm:@gotgenes/pi-subagents-worktrees` from your pi settings to keep lanes parallel; doctor warns while it is configured.
- **Known limit.** Without an executor, a pi `/fork` or `/clone` of your main session is treated as a child: no phase card, and subagent and lane tools refuse there.

## Reference

### Commands

| Command | Does |
|---|---|
| `/livespec` | prints the installed version |
| `/livespec init` | creates missing starter files and the agent-skills clone |
| `/livespec doctor` | checks pack, config, clone, forge account, approver chain, executor |
| `/livespec validate` | validates `specs/` |
| `/livespec next` | polls answers and prints the next step |
| `/livespec account [name]` | shows or switches the forge account of this clone |
| `/livespec skills status\|update\|pin <sha>\|unpin\|rollback` | manages the agent-skills clone |
| `/livespec audit [#T]` | read-only drift audit of the integration branch |
| `/livespec migrate-openspec` | moves `openspec/specs/*/spec.md` to `specs/` |

### Agent tools

You rarely call these yourself; they are what the phase card names.

| Area | Tools |
|---|---|
| State | `spec_status`, `spec_next`, `spec_validate`, `forge_read` |
| Change | `change_new`, `change_start`, `spec_write`, `change_split`, `change_sync`, `change_park`, `change_resume`, `change_ship`, `change_push`, `change_close` |
| Human requests | `spec_gate`, `spec_question`, `spec_stuck`, `unit_amend`, `initiative_propose`, `new_dependency` |
| Build | `plan_units`, `unit_start`, `unit_finish` |
| Review and ship | `spec_review`, `finding_rebut`, `docs_table` |
| Small fix | `fix_start`, `fix_ship` |
| Subagents | `subagent_dispatch`, `subagent_answer`, `subagent_packet`, `subagent_record`, `lane_open`, `lane_merge` |

### Configuration

Project config: `.pi/livespec/config.yaml`. User config: `~/.pi/agent/livespec/config.yaml`. Unknown keys and invalid values are warnings; defaults apply.

| Key | File | Default | Meaning |
|---|---|---|---|
| `forge` | project | from `origin` | `github` or `gitea` |
| `host`, `githubHosts`, `giteaUrl` | project | — | self-hosted forge hosts |
| `integrationBranch` | project | forge default branch | branch changes start from and merge into |
| `testCommand` | project | — | command `fix_ship` runs; required for the small-fix lane |
| `verify.setup` | project | symlink `node_modules`, `.venv`, `vendor` | command that prepares a temporary Verify worktree |
| `verify.timeout` | project | `600` | seconds per Verify run |
| `interaction.adapter` | project, then user | `[in-session]` | ordered approver chain: `in-session`, `forge` |
| `agentSkills.channel` | user only | `auto` | `auto`, `notify` or `pinned` updates of agent-skills |
| `lanes` | user | `3` | max parallel lanes |
| `packetBudgetTokens` | user | `24000` | packet size before sources spill to files |
| `isolation.excludePackages` | user | `[]` | pi packages not loaded in livespec children |

The flow pack ships at `src/packs/agent-skills.yaml`. A project can extend or replace it with `.pi/livespec/flow.yaml` (loop caps, limits, tag paths and keywords, lane thresholds, subagent policy). An invalid pack stops livespec and doctor lists the errors.

### Files in your repository

```text
specs/
├── product.md                 # mental model and main flows
├── glossary.md                # shared terms
├── constraints.md             # quality bar
├── decisions/NNNN-<slug>.md   # decision records
├── bare-work.md               # log of work done outside any change
└── <capability>/spec.md       # living spec, edited in place
.pi/livespec/config.yaml       # project config
.pi/livespec/flow.yaml         # optional flow pack override
```

The agent cannot write `.pi/livespec/`; edit it yourself. Local caches (`~/.pi/agent/livespec/`, `<git common dir>/livespec/`) are safe to delete.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| No phase card | project not initialized (`/livespec init`, `/reload`), or the branch is not `livespec/*`/`fix/*` and no change is resolvable: `/livespec next` lists open changes |
| `livespec guard:` blocked a command | the agent tried `git push`, `gh`/`tea` writes or a `.pi/livespec/` edit. The reason names the livespec tool to use instead |
| Gate request refused | read the reason: open blocking question, unanswered stuck report, pending request, dirty tree, parked change or a failing check. Fix that first |
| `spec_gate` refuses naming `interaction.adapter` | no adapter is available: in print mode add `forge` to the chain |
| My `/livespec approve` did nothing | it was posted before the request, by an account without write access, was ambiguous, or `approve` was used while a waivable check fails (`choose waive`). The card shows the reason |
| Approval recorded as `superseded` | `HEAD`, the issue body or the tree changed after the request. Ask the agent to request the gate again |
| Forge writes blocked / read-only | doctor shows the account state. Log in with `gh`/`tea`, or switch with `/livespec account <name>` |
| Unit `BLOCKED` | attempts exhausted; answer the stuck report |

## Documentation

- [Project brief](docs/project-brief.md): intent, goals, non-goals and constraints.
- [Architecture](docs/architecture.md): modules, where data lives, the phase flow in depth.
- [Glossary](docs/glossary.md): the vocabulary used by the specs and issues.
- [Roadmap](docs/roadmap.md): the specs in build order, with their issues.
- [Decisions](docs/decisions/): architecture decision records.

## Development

This repository is built with [pi-superspec](https://github.com/ttdua/pi-superspec):

- Each roadmap spec is one GitHub issue, one OpenSpec change and one pull request. The issue names the change.
- To start a spec, run `/opsx-new <change-name>` and use the issue as the input to brainstorming.
- Once a change is archived, the behavior it built is recorded in `openspec/specs/`.

There are two kinds of spec folder, and they are easy to confuse:

- `openspec/` is this repository's own development record, managed by pi-superspec.
- `specs/` is the folder pi-livespec creates in the projects that *use* it.

```sh
bun install
bun run test
bun run typecheck
```

Repository content is in English. `README.vi.md` is a Vietnamese translation of this README: update it in the same pull request when you change this file.

## License

MIT. See [LICENSE](LICENSE).
