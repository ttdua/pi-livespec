# context-injection Specification

## Purpose

Defines what livespec injects into the session: the routing note, the phase card and resuming a change at session start.

## Requirements

### Requirement: Routing note
In an initialized project, the system SHALL place a static routing note at the start of the context of the main session, as a system prompt section. A child session (see `child-sessions`) MUST get the child note instead of the routing note. The routing note's text MUST be identical on every turn and MUST NOT depend on the change, the phase, the time or the installed agent-skills commit.

#### Scenario: Identical every turn
- **WHEN** five turns run with different change states
- **THEN** the routing note text is byte-identical in all five

#### Scenario: Child session gets the child note
- **WHEN** a child session of an initialized project starts an agent run
- **THEN** the `livespec` system prompt section is the child note, not the routing note

### Requirement: Routing note content
The routing note MUST state what livespec is, that all forge writes and pushes go through livespec tools, and that updates from the integration branch are merges and never rebases. It MUST include a short summary of agent-skills' Core Operating Behaviors with MIT attribution to agent-skills.

#### Scenario: Rules stated
- **WHEN** the routing note is rendered
- **THEN** it states the livespec-tools-only rule for forge writes and pushes and the merge-never-rebase rule

#### Scenario: Attribution
- **WHEN** the routing note is rendered
- **THEN** it contains the Core Operating Behaviors summary and names agent-skills and the MIT license

### Requirement: Phase card
In an initialized project, on every LLM call of the main session the `context` hook SHALL append exactly one phase card message at the end of the messages and MUST leave every earlier message unchanged. The card MUST NOT be persisted in the session, so each call's input holds no earlier card and cards never accumulate.

#### Scenario: Appended at the end
- **WHEN** the `context` hook runs on a list of N session messages
- **THEN** the result has N+1 messages, the first N equal the input, and the last is the phase card

#### Scenario: Cache prefix stable over five turns
- **WHEN** five consecutive turns run through the hooks, each adding messages to the session
- **THEN** on every turn the routing note is byte-identical, the hook output minus its last message equals that turn's input, and no earlier card appears in the input

#### Scenario: No card in a child session
- **WHEN** the `context` hook runs in a child session on a list of N messages
- **THEN** it returns the N messages unchanged

### Requirement: State refresh
The snapshot behind the phase card SHALL be rebuilt at `session_start`, at `before_agent_start` for every user prompt, after every livespec tool that writes, and when `spec_status`, `spec_next` or `/livespec next` runs. Within one agent run between those points, the card MAY show the last snapshot.

#### Scenario: Issue edited between prompts
- **WHEN** a unit is ticked on the forge between two user prompts and no livespec tool is called
- **THEN** the card of the second prompt shows the unit as done

#### Scenario: After a write tool
- **WHEN** `spec_write` writes the Proposal during a run
- **THEN** the next card in that run no longer asks for the Proposal

### Requirement: Phase card content
The card SHALL show:
- the change and its phase;
- the next step and the required skills;
- the active phase's redirects;
- open blocking questions;
- counters with their caps;
- active units, started units and blocked units with their reason;
- the items of the latest `incomplete` comment;
- optional skills that still need a skill note;
- pending approver requests, with subject and adapter;
- frozen and stale units;
- an unanswered stuck report;
- forge command comments ignored by the last poll, with the reason;
- the sections registered by other specs.

Forge text MUST be wrapped as untrusted content, and a stale snapshot MUST be stated.

#### Scenario: Card contents
- **WHEN** the change is in `define` with redirects and an open blocking question
- **THEN** the card shows the change number, `define`, the next step, `spec-driven-development`, both redirects and the question wrapped as untrusted

#### Scenario: Stale card
- **WHEN** the snapshot comes from the cache in read-only mode
- **THEN** the card states that the data is stale and that writes are refused

#### Scenario: Registered section
- **WHEN** a test registers a card section
- **THEN** its text appears in the card after the built-in sections

#### Scenario: Pending approvals shown
- **WHEN** a forge request for `gate:plan` is pending and U2 is frozen
- **THEN** the card lists the pending `gate:plan` request with adapter `forge` and names U2 as frozen

#### Scenario: Ignored command shown
- **WHEN** the last poll ignored a `/livespec approve` comment from a user without write access
- **THEN** the card names the comment's author and the reason, wrapped as untrusted

#### Scenario: Evidence shown
- **WHEN** the change is in `build`, U1 is started at pre SHA `abc1234` and U2 is blocked by `progress`
- **THEN** the card names U1 as started with `abc1234` and U2 as BLOCKED with reason `progress`

### Requirement: Cache evidence
The change SHALL record a manual smoke run of at least five turns against a real model, listing per turn the uncached input and cache-read tokens with and without the livespec hooks, in the format of probe (c) in `docs/evidence/host-seams.md`. The run passes when, from turn 2 on, each hooked turn's cache-read tokens are within one cache block of the control turn, or the hooked turn reads more; an isolated full miss counts only if the control run shows none.

#### Scenario: Smoke recorded
- **WHEN** the change is verified
- **THEN** the change folder contains the smoke record with at least five turns per run, the models used, and the pass or fail verdict under the rule above

### Requirement: Resume at session start
At `session_start` of the main session in an initialized project, the system SHALL map the branch `livespec/<name>` to the open `livespec` change issue whose `Branch:` line equals that branch, falling back to the open change titled `<name>` with a warning, and SHALL show the phase card for it without being asked. On a fix branch the card SHALL be small-fix-lane "Fix card". On any other branch, the card SHALL list the open changes with their phases. The first card of a session MUST point at `specs/product.md` to be read.

#### Scenario: Resume mid-change
- **WHEN** a new session starts on `livespec/per-ip-cap` and the matching issue is in `build` with U3 pending
- **THEN** the card shown at session start names the change, phase `build` and U3 as the next step

#### Scenario: Other branch
- **WHEN** a session starts on `main` with two open changes
- **THEN** the card lists both changes with their phases

#### Scenario: Fix branch
- **WHEN** a session starts on `fix/typo` with two open changes
- **THEN** the card is the fix card for `fix/typo` and does not list the changes

#### Scenario: Product pointer
- **WHEN** the first card of a session is rendered
- **THEN** it asks the agent to read `specs/product.md`

#### Scenario: Forge unavailable
- **WHEN** forge detection fails at session start
- **THEN** the card says the forge is unavailable, the session continues, and no error is thrown into pi

#### Scenario: Child session start
- **WHEN** a child session starts in an initialized project on `livespec/per-ip-cap`
- **THEN** no phase card is shown or added

### Requirement: Uninitialized project
In a project without `.pi/livespec/config.yaml`, the system SHALL NOT inject the routing note or the phase card. At `session_start` it SHALL show one message suggesting `/livespec init`, and when an `openspec/` folder exists it SHALL also suggest `/livespec migrate-openspec`. It MUST NOT run init or migration automatically.

#### Scenario: Plain project
- **WHEN** a session starts in an uninitialized project
- **THEN** one message suggests `/livespec init`, and no context is injected on later turns

#### Scenario: OpenSpec project
- **WHEN** a session starts in an uninitialized project with an `openspec/` folder
- **THEN** the message suggests `/livespec migrate-openspec` and `/livespec init`, and no file changes
