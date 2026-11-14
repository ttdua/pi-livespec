# host-seam-evidence Specification

## Purpose

Defines the evidence document that records how pi behaves at the host seams later specs rely on, so each design assumption has a checked result and a named fallback before it is built on.

## Requirements

### Requirement: Evidence document with one section per probe
`docs/evidence/host-seams.md` SHALL contain exactly one section for each probe (a) to (j). Each section MUST state the question, the method (pi version, executor or package versions, steps), the raw result and the consequence for the design.

#### Scenario: All probes present
- **WHEN** the evidence document is read
- **THEN** it has a section for each of probes a, b, c, d, e, f, g, h, i and j

#### Scenario: Section content
- **WHEN** any probe section is read
- **THEN** it contains Question, Method, Result and Consequence

### Requirement: Fallback for failed or unverified probes
A probe whose result contradicts the design assumption, or that could not be verified, MUST name a fallback in its section. An unverifiable probe MUST be marked unverified with the reason and MUST NOT contain an assumed result.

#### Scenario: Failed probe
- **WHEN** a probe result contradicts the assumption
- **THEN** its section names a fallback

#### Scenario: Unverifiable probe
- **WHEN** a probe cannot be run
- **THEN** its section is marked unverified with the reason, names a fallback and states no result

### Requirement: Decisions follow the evidence
When a fallback changes a decision in `docs/decisions/`, this change SHALL add a new ADR or mark the old one `Superseded` with a link to its replacement, and `docs/decisions/README.md` MUST list it.

#### Scenario: Fallback changes a decision
- **WHEN** a probe fallback conflicts with an accepted ADR
- **THEN** a new ADR exists or the old ADR is marked `Superseded` with a link, and the README table lists it

### Requirement: No kept probe code
Probe code SHALL NOT be kept in `src/`, and SHALL NOT remain as files after the evidence is written; only short snippets MAY appear inside evidence sections.

#### Scenario: Source tree is clean
- **WHEN** the change is complete
- **THEN** `src/` contains no probe code and no probe files remain outside `docs/evidence/host-seams.md`

### Requirement: Probes do not alter the user's pi configuration
Probes MUST run in a scratch pi home and project directory and MUST NOT modify the real pi settings or installed packages.

#### Scenario: Real config untouched
- **WHEN** the probes finish
- **THEN** the real pi settings file and package list are unchanged
