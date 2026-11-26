## MODIFIED Requirements

### Requirement: In-session presentation
The in-session adapter SHALL show the facts first and then the briefing. In the in-session dialog (approver-adapters "In-session dialog") they SHALL be their own sections above the entries, the briefing under its author heading; in the `select` fallback they SHALL be in the title of the first `select`. Each entry SHALL read `<label> — <description>` when the choice has a description (in the dialog the description MAY be drawn on the line below the label, and is left out where approver-adapters "Dialog layout and text safety" hides descriptions on a narrow terminal), the recommended entry SHALL be listed first and end with ` (Recommended)`, and no entry SHALL show a raw `[<id>]` suffix. The adapter MUST keep mapping the picked entry back through its own table and MUST NOT infer identity from the label text.

#### Scenario: Recommended entry first
- **WHEN** a stuck request has options A and B, B recommended, and is shown in session
- **THEN** the first menu entry is B's label with its description and ` (Recommended)`, and picking it records choice `B`

#### Scenario: Briefing shown before options
- **WHEN** `spec_gate define` runs in session through the `select` fallback with a briefing
- **THEN** the `select` title contains the define payload followed by the briefing summary and rationale

#### Scenario: Briefing section in the dialog
- **WHEN** `spec_gate define` runs in session in the dialog with a briefing
- **THEN** the Decision tab shows the define payload, then the heading `Agent recommendation (agent-authored, advisory)` with the briefing summary and rationale, then the entries
