# Changelog

All notable changes to pi-livespec are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Breaking

- Machine records (`decision`, `dispatch`, `finding-summary`, `receipt`, `unit-start`, `counter`) move from issue comments to a git ledger (#59). Changes in flight lose their comment-based receipts, decisions and counters: finish them on the previous version, or wait for the migration (#62). Comments of these kinds are ignored with a warning.
- `finding_rebut`: the first argument is now a ledger entry ref, not a comment id. The verifier `finding` reference is `<aggregateRef>:<index>`. Packet source ids for these records are `ledger:<issue>/<ref>`.
- `/livespec answer --changes` is removed: the forge refuses it with a message that names the replacement. Edit the spec instead; livespec cascades requirement edits from the spec diff.
- `unit_finish` refuses outside the per-unit phase (`build`).

### Added

- **Git ledger:** machine records are append-only entries on `refs/livespec/<issue>`, synced with `origin` (fetch before first use, replay on divergence, fast-forward-only push). `change_ship` refuses until the ledger is pushed (#59).
- **`ledger.retain`** project config (default `true`); `false` deletes the ledger at `change_close`.

### Changed

- Agent git commands that write `refs/livespec/*` are blocked; reads stay allowed.
- Issues carry far fewer comments: only human-facing records stay on the forge.
- The requirement cascade is derived from the spec diff, with whitespace-only edits ignored. Plan gates record requirement digests as the cascade baseline.

## [0.2.0] - 2026-11-26

Human requests are now prepared by the agent and easier to answer: briefings with a recommendation, readable forge comments, and one dialog per request in the pi TUI.

### Breaking

- `spec_gate` requires a `briefing` for human gates (`define`, `plan`, `ship` and named gates). Self gates ignore it (#53).
- `spec_stuck` requires a `description` on every option and a `rationale` with the recommended option (#53).

### Added

- **Request briefings:** every human request can carry a briefing (summary, watch points, recommended choice, rationale), shown after the facts and labelled advisory. `unit_amend`, `initiative_propose` and `new_dependency` accept an optional briefing (#53).
- **Rule briefings:** rule asks (`decide`) carry rule-authored option descriptions and a recommendation, labelled `Livespec rule recommendation` (#53).
- **Question candidates:** `spec_question` accepts 2 to 4 candidate answers, each a label and a description, that the human can pick in session or answer with `/livespec answer Q<n> <label>` (#53).
- **In-session dialog:** in the pi TUI each request is one dialog with Decision, Adjust units and Review tabs, so the answer is checked on Review before it is sent; other modes keep the select prompts (#56).
- **New gate presentation:** the forge `request` comment is a readable markdown layout (Decision needed heading, facts, failing checks, briefing, How to answer table, collapsed command list); the in-session menu shows `<label> — <description>` with the recommended entry first (#53).

### Changed

- `@earendil-works/pi-tui` is a peer dependency (`*`) (#56).
- `subagent_dispatch`, `subagent_packet` and `subagent_record` treat an empty `unit`, `subject` or `finding` as omitted, and ignore a `subject` for a role other than `reviewer` or a `finding` for a role other than `verifier`, with a warning at the top of the tool result instead of a refusal (#52).

### Fixed

- `subagent_dispatch` no longer crashes when a child asks the parent a question: `pendingQuestion` is read as the executor's plain string (#51).
- Forge request comments close only fences that are really open (quoted or mismatched fences no longer reopen); approval requests show the stored summary; a recommending rule's briefing is checked when it asks; in-session titles and labels are neutralised; `spec_question.recommended` accepts only `A` to `D` (#55).

## [0.1.0] - 2026-11-25

First release. It covers roadmap specs LS-01 to LS-10; LS-11 (dogfood comparison with pi-superspec) is still in progress.

### Added

- **Scaffold and host seams** (LS-01): the pi extension package and the host seams it relies on (#12).
- **Spec core** (LS-02): parsers and validators for living specs, change issue bodies, units, decisions and the glossary; `/livespec validate` and `/livespec migrate-openspec` (#13).
- **Forge layer** (LS-03): GitHub (`gh`) and Gitea (REST) adapters with versioned writes, a cache and read-only mode (#14); per-clone forge accounts and `/livespec account` (#16).
- **Engine and content** (LS-04): the YAML flow pack, the phase card and routing note, next-step computation, the shared agent-skills clone, `/livespec init`, `doctor`, `next` and `skills` (#15).
- **Gates and decisions** (LS-05): `spec_gate`, questions, stuck reports, unit amendments, the in-session and forge approver adapters, forge `/livespec` command comments, and rule-based decision points (#21, #25, #26).
- **Unit evidence and guards** (LS-06): `unit_start`/`unit_finish` with red/green receipts, `verify-red-on-base`, attempt limits, the settle hook, and the `tool_call` guard that blocks direct pushes and forge writes (#29).
- **Subagents** (LS-07): role dispatch through a capability-detected executor, context packets, an inline fallback and parallel lanes (#30).
- **Review** (LS-08): `spec_review` with reviewer fan-out, personas by tag, verifier disputes, finding routing and rebuild markers (#31).
- **Ship and close** (LS-09): `docs_table`, `change_ship`, `change_push`, pull request feedback polling and `change_close` (#35); the small-fix lane with `fix_start`/`fix_ship` (#36); initiatives, `change_split`, `change_sync` and discovered dependencies with park and resume (#39, #47).
- **Durable docs and drift audit** (LS-10): the `product-impact`, `glossary-terms` and `behavior-change` checks, and the read-only `/livespec audit` with triage (#48).
- **Documentation**: a README with setup, workflows and a human gate guide, plus a Vietnamese translation (#49).

### Fixed

- Async questions no longer block planning (#22).
- Gate payloads link the issue, and the next step names `plan_units` (#23).
- Approver adapter artifacts synced after LS-05 (#27).
- Empty (already landed) fix branches are detected the same way by the card, `fix_ship` and `change_new --from-fix` (#38).
- Closing keywords in commits and URLs are rewritten to references; review comments without a line are ingested (#43).
- `change_park` parks from `HEAD` after a resume instead of a stale wip head (#44).
- LS-09 post-merge review follow-ups (#46).

### Known limitations

- Tracking issues created before #39 carry no request marker, so a crashed in-flight initiative completion from before that change is not reused.
- Guard limits are listed in [Architecture: Evidence and guards](docs/architecture.md#evidence-and-guards).

[Unreleased]: https://github.com/ttdua/pi-livespec/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/ttdua/pi-livespec/releases/tag/v0.2.0
[0.1.0]: https://github.com/ttdua/pi-livespec/releases/tag/v0.1.0
