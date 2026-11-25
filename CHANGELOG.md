# Changelog

All notable changes to pi-livespec are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

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

[0.1.0]: https://github.com/ttdua/pi-livespec/releases/tag/v0.1.0
