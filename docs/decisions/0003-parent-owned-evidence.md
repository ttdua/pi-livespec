# 0003: The parent session owns evidence

Status: Accepted (2026-11-13)

## Context

Agents claim work is done without proof. Subagents may or may not load the parent's extensions, depending on the executor.

## Decision

- Receipts do not depend on what a child session loads. The parent runs `unit_start`, which requires a clean tree and a `Verify` that fails. It runs `unit_finish`, which requires a clean tree, a matching digest and a `Verify` that passes at HEAD. Then it posts the receipt and ticks the unit.
- A subagent only implements and commits. It never ticks, pushes or writes to the forge.
- Without a subagent plugin, the same steps run inline and produce the same evidence.

## Consequences

- Every unit needs exactly one `Verify` command that is red before the work. The only exception is a refactor unit, whose `Verify` must be green both before and after.
- A claim made by a subagent counts only when the evidence supports it.
