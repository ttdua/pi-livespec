## Context

- LS-05 shipped `src/interaction/` (approver contract, adapters, polling, completion), `src/engine/locks.ts` and `src/engine/iterations.ts`. Verify W3–W7 and W11 list where the archived design, plan and the living specs drift from that code.
- `deriveLocks` (`src/engine/locks.ts`) clears a stale unit only with an approved amendment newer than the `stale` comment. Before any lock, `unit_amend` refuses ("the plan is not locked yet"), so a pre-lock stale unit can only be cleared by an amendment after the lock.
- `pollChange` (`src/interaction/poll.ts`) applies every `class` command `matchCommands` returns for a pending question on every poll, until the question's request completes.
- `adapterChain` (`src/config.ts`) picks the project list whenever it is defined, even when `readInteraction` dropped every name.
- Unused: `Approver.poll` (forge implementation only, in-session stub), `ApproverUI.confirm` (wired in `approver-for.ts`, never called), `GateSnapshot.digests` (written in `spec-gate.ts`, never read), `LockState.stalePhases` (derived, never read).
- `summary` in `src/interaction/complete.ts` wraps `record.reason` in `untrusted`. Reasons are built from `gateRefusal` sentences that already wrap forge text, so the check message is wrapped twice.

## Goals / Non-Goals

**Goals:**
- Specs and archived artifacts match the code.
- Three behaviour fixes: pre-lock stale units, `class` applied once, adapter fallback.
- Remove dead contract members; tighten `Subject` and snapshot types.

**Non-Goals:**
- W1, W2, W8, W9, W10 (closed by #17, #18, #19, #24).
- Wiring a real use for `Approver.poll`.

## Decisions

### D1. A plan approval clears stale units

`staleUnitsOf` treats a unit as cleared when an approved amendment for it, or an approved non-superseded plan `gate` comment, is newer than the `stale` comment. While a lock exists, the plan gate already refuses while a unit is stale (and the forge answer is validated against the same refusal), so a newer plan approval can only exist when no unit was stale at request time, or when the stale comment predates the first lock. The rule therefore only changes the pre-lock case. Alternative: special-case "first lock" — rejected, it needs the order of locks and says the same thing.

An approved amendment with identical content already clears the unit (the rule ignores content). The spec now states it.

### D2. `class` commands are applied once, with a `class` marker

After `applyClasses` rewrites a question's class, `pollChange` posts an own marked comment of kind `class` with id = the command comment id and data `{ question, class }`. `matchCommands` receives the set of applied command ids (from own `class` markers) and skips those commands. A command is recorded even when the body already holds that class (no write needed), so it is never reconsidered. When the body write conflicts, no marker is written and the next poll retries.

Alternatives:
- Compare the command time with the issue's `updatedAt` — rejected: any unrelated body edit between the command and the poll would drop the command.
- Remember applied ids in the session — rejected: a new session would re-apply.

`class` joins the registered marker kinds through `registerKind` in `approver.ts`, like `request` and `answer`.

Known gap: the body write and the marker are two forge writes. If the body write succeeds and the marker write fails, the next poll applies the command again (overwriting a manual edit made in between) and then records it. Writing the marker first would instead lose the command when the body write conflicts. The window is one failed comment write; the session records the failure. (Agent's call, stated in the spec.)

### D3. Empty project adapter list counts as unset

`adapterChain` uses the project list only when it is non-empty, then the user list when non-empty, then the default. `readInteraction` keeps reporting each dropped name. The doctor source becomes `user` or `default` accordingly. (User decision in brainstorm.)

An explicit `adapter: []` in project config is treated the same way: today it masks the user chain (pinned by the test "present project setting wins even when empty…"), after this change it falls back. `readInteraction` returns the same `{ adapter: [] }` for both cases, and an empty chain can never answer anything, so one rule is simpler and loses nothing. (Agent's call; the test is replaced.)

### D4. Dead contract members are removed

- `Approver.poll` and the forge/in-session implementations are removed; `pollApprovals` is the only answer path. The spec contract drops `poll(requestId)`.
- `ApproverUI.confirm` is removed from the type and from `approver-for.ts` / `session.ts` adapters. In-session code keeps using `select` for yes/no (it cannot tell "no" from cancel with `confirm`).
- `GateSnapshot.digests` is removed from the type and from `spec-gate.ts`. Old request comments that carry it still parse: snapshot readers ignore unknown fields.
- `LockState.stalePhases` and `stalePhasesOf` are removed; `validGatesOf` already covers stale phases.

### D5. Stricter `Subject` and snapshot narrowing

`Subject` becomes `` `gate:${string}` | `amend:${number}` | `question:Q${number}` | `stuck:S${number}` | `decide:${string}` ``. Parsing untrusted request yaml (`asRequestRecord`) validates the prefix, so a malformed subject is not a request.

Snapshots get a typed accessor `snapshotOf(record)` in `requests.ts` returning a discriminated union keyed by subject prefix (`{ kind: "gate"; snapshot: GateSnapshot } | …`), replacing the `as XSnapshot` casts in `complete-*.ts` and `complete-validate.ts`. The stored yaml is unchanged; the discriminant is derived from `subject`, not written. It is a typed view, not shape validation: request records are own marked comments written by the plugin, so their snapshot is trusted as today. Handlers narrow on `kind` for type safety only. Alternative: add a `kind` field to every stored snapshot — rejected, it changes the marker format and needs a fallback for comments already on issues.

### D6. Superseded reason wrapped once

Superseded reasons are plugin sentences whose forge parts are already wrapped by the refusal rules and validators that built them. `summary` stops wrapping `record.reason`; the subject keeps its wrapping. `validateAmend` messages that embed unit validator text wrap that text where they are built, so every superseded reason has forge text wrapped exactly once.

### D7. Archived artifacts are corrected in place

The archived `gates-and-decisions` `design.md` (D3, D5, D9, D13), `plan.md` (Contracts rows `Approver`, `ApproverUI`, `RequestRecord`/`GateSnapshot`, `LockState`, `Subject`, marker `stuck` data, `interaction.adapter`, plus the kind mapping) and `proposal.md` (Loop counters, known gaps) are edited where they are wrong. Each file ends with an `## Errata (#20)` section listing the corrections, so the history stays readable. `docs/architecture.md` is updated where it states the contract.

## Risks / Trade-offs

- [A new marker kind adds one comment per applied `class` command] → Commands are rare; the marker makes the poll idempotent across sessions.
- [Removing `Approver.poll` drops a contract member the LS-05 spec required] → The spec is modified in the same change; no caller exists.
- [Old request comments carry `digests`] → Readers ignore unknown snapshot fields; no migration.
- [Pre-lock stale clearing could hide a real staleness] → The plan gate shows every unit in its payload and locks them as reviewed; a unit approved there is current by definition.
