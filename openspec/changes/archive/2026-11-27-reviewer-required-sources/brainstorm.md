## Design Summary

Issue #68: reviewer packets mark every source as required, including one `comment:<id>` per `decision` record and one `answer:<agentId>:<n>` per parent answer. With 60–120 required ids, reviewers routinely leave one out of `sources_used`; after one return the run is recorded as BLOCKED by the parent (`sources_used: []`), and the `finding-summary` drops the reason. In naicoi92/iroh-tunnel#268, 10 of 23 review runs blocked this way and each passed on redispatch.

Goal: a reviewer's required list holds only what the reviewer must judge, so its size does not grow with the number of decision records or parent answers, and a block for omitted sources says which ids were omitted.

Scope (agreed): reviewer packets only. Implementer packets keep `answer:<agentId>:<n>` as required per-answer sources, because an answer to the unit's own child is an instruction the implementer must follow, and freshness before finish relies on those ids.

Behaviour after the change:
1. In a reviewer packet with subject `unit`, `change` or `persona:<name>`, all `decision` records become **one optional** source and all parent answers to children become **one optional** source. Their count no longer changes the required list.
2. A result that omits an optional source is never returned to the child and never blocks; `completed` depends on required sources only.
3. The packet tells the child which sources are required and which are optional, and the protocol asks it to list every required source it used (optional ones when it used them).
4. A `finding-summary` records the run's `notes`, `reason` and `evidence`, as a `dispatch` record does. A parent-written BLOCKED for omitted sources names the omitted ids in `reason`.

Living requirements this alters (stated explicitly):
- `subagent-packets` / Context manifest: the reviewer list's "the decision records" becomes an optional grouped source, and the parent answers become an optional grouped source; required vs optional is introduced as a manifest concept.
- `subagent-packets` / Source ids and versions: a new id form for grouped record sources.
- `subagent-packets` / Packet layers or Protocol content: the packet marks optional sources; the protocol wording on `sources_used` changes.
- `subagent-dispatch` / Result handling: the missing-source return applies to required sources only (already worded so; a scenario pins that an optional omission is accepted) and the BLOCKED reason names the ids.
- `subagent-dispatch` / Return contract: `sources_used` must list the required sources used; optional ones may be listed.
- `review-findings` / Finding summary comment: adds `notes`, `reason` and `evidence`.

Non-goals: the respawn loop that inflates answers (#66); moving decision records into a ledger (#59); changing implementer, verifier, scout, spec- or plan-review manifests; raising `MISSING_SOURCE_RETURNS`.

## Alternatives Considered

### Alternative A: Grouped optional record sources (issue fix)
- **Approach**: one optional source per record kind (`decisions`, `dispatch answers`) in reviewer packets; required list = must-judge sources; summaries keep the why.
- **Pros**: required list is constant in the number of records; fewer ids in the packet; matches the issue's "Done when".
- **Cons**: a new source id form; grouped source version changes whenever any record changes.
- **Why not chosen**: chosen.

### Alternative B: Keep per-record ids, mark them optional
- **Approach**: leave `comment:<id>` / `answer:<agentId>:<n>` per record, set `required: false`.
- **Pros**: no new id form; smallest diff.
- **Cons**: packets still list 40+ ids; children still try to enumerate them; no grouping as the issue asks.
- **Why not chosen**: keeps the noise that causes the omissions; the issue explicitly asks for one source per kind.

### Alternative C: More returns before blocking
- **Approach**: raise `MISSING_SOURCE_RETURNS` to 2–3.
- **Pros**: one-line change.
- **Cons**: every round costs extra child turns; does not fix the required list growing with records; still loses the reason.
- **Why not chosen**: treats the symptom, not the cause.

## Agreed Approach

Alternative A, limited to reviewer packets with subject `unit`, `change` or `persona:<name>` (the only manifests holding decision records and all parent answers today), plus the summary fields of fix 3, which apply to every reviewer and verifier `finding-summary`.

## Key Decisions

- Scope is reviewer packets only; implementer keeps per-answer required sources (user decision).
- Required for the reviewer stays as today for everything except the two grouped record sources: the diff, specs, constraints, receipts, the change issue, answered questions (`answer:Q<n>`, human decisions on requirements), review comments and checks, the rubric, the persona file, the product excerpt and the durable doc readers. Only decision records and parent answers become optional (my call: the issue's evidence is entirely those two kinds; narrowing other sources is not needed to meet "Done when").
- An empty record kind adds no grouped source.
- The BLOCKED reason format names the omitted ids (it already does in `interpret`; the summary now keeps it).
- Re-running round 1 of a #268-shaped change is verified with a fixture test, not a live forge run.

## Open Questions

None blocking. Exact grouped id spelling and how the packet marks optional sources are left to `design.md`.
