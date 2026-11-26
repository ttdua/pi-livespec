## Why

A request answered in session today is a chain of `select` and `input` dialogs: a gate can open three to six in a row, the facts and the briefing are packed into the title of the first `select`, and the human cannot look over the whole decision before it is sent. The gate-briefing change made requests worth reading; this change makes them readable in the terminal: one dialog per request, with the facts, the briefing, described options, notes and a review step on one screen.

## What Changes

**In-session dialog**
- From: the in-session adapter asks through `ctx.ui.select` and `ctx.ui.input` only, one dialog per step (action, notes yes/no, notes, adjust yes/no, unit, field, value).
- To: when the session can draw custom UI (`ctx.mode` is `tui` and `ctx.ui.custom` is available), the adapter shows one dialog per request, drawn with `ctx.ui.custom()`: a Decision tab (facts, briefing, described options, recommended first), notes written inside the dialog, an Adjust units tab when the request has overridable units, and a Review tab every answer passes before it is sent. Questions, stuck reports and rule asks use the same frame. When the dialog cannot be drawn, the adapter uses the current `select`/`input` chain, with the same outcomes.
- Reason: one screen per decision, readable facts and briefing, and a final review before an answer is recorded on the issue.
- Impact: non-breaking for tools and the forge; the in-session experience changes in the pi TUI only. Cancel stays `dismissed`, answer records are unchanged.

**In-session presentation**
- From: the facts and the briefing are shown in the title of the first `select`.
- To: in the dialog they are their own sections above the options; the title form stays for the fallback chain. The entry rules (`<label> — <description>`, recommended first with ` (Recommended)`, no raw ids, identity through the adapter's table) apply to both.
- Reason: long facts and briefings are hard to read in a select title.
- Impact: non-breaking.

**Dependency**
- `@earendil-works/pi-tui` is added as a peer dependency (`"*"`, approved by the user) for width-aware measuring, truncation and wrapping in the dialog. It ships with every pi host.

## Capabilities

### New Capabilities
- (none)

### Modified Capabilities
- `approver-adapters`: "In-session adapter" asks through one custom dialog when the session can draw it, and keeps the `select`/`input` chain as the fallback; the dialog's tabs, notes, review step, keys and cancel behaviour become requirements.
- `request-briefing`: "In-session presentation" shows the facts and the briefing as dialog sections, keeping the select-title form for the fallback.

## Impact

- Code: `src/interaction/in-session.ts` (flow selection, fallback), new dialog modules under `src/interaction/` (state, key handling, rendering), `src/interaction/menu.ts` (shared entry building), `src/interaction/approver.ts` (`ApproverUI` gains an optional custom-dialog entry), `src/tools/approver-for.ts` (passes `ctx.mode` and `ctx.ui.custom`).
- Tests: new unit tests for dialog state, keys and rendering (headless, fixed widths); the existing in-session tests keep covering the fallback chain.
- Dependencies: `@earendil-works/pi-tui` peer dependency; no rpiv package.
- Docs: README and README.vi.md (in-session adapter row and keys), `docs/architecture.md` (interaction section), CHANGELOG Unreleased.
- Unchanged: forge adapter and comment format, answer records, tool parameters, `parseCommand`.
