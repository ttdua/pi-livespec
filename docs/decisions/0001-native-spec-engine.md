# 0001: Native spec engine, living specs edited in place

Status: Accepted (2026-11-13)

## Context

OpenSpec provides spec format, deltas (ADDED/MODIFIED/REMOVED merged on archive) and validation. Its notion of "done" is that a file exists, and its CLI requires a recent Node and changes quickly. Parsing and merging deltas is the hardest part of OpenSpec to reproduce.

## Decision

pi-livespec owns its spec layer in TypeScript and does not depend on the OpenSpec CLI.

- It keeps the OpenSpec spec format: Requirement with SHALL/MUST, Scenario with WHEN/THEN.
- A change edits `specs/<capability>/spec.md` in place on its branch, as litespec does. The delta is `git diff <Base>..HEAD -- specs/`, and `git merge` resolves conflicts between changes.
- The change issue declares `Capabilities: new [...], modified [...]`. The validator compares that declaration with the spec files the diff actually touches.

## Consequences

- No delta parser and no merge step. The define gate shows the real diff.
- The engine, parser and validator have to be written and maintained here.
- Moving from OpenSpec means moving `openspec/specs/*` to `specs/*`; the file contents stay the same.
