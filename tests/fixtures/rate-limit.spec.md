---
paths: ["src/middleware/ratelimit.ts", "src/limits/**"]
---
# rate-limit

## Purpose
Why this capability exists, in one or two sentences.

## Requirements

### Requirement: Per-IP cap
The system SHALL reject a request when one IP has sent more than 100 requests in the last 60 seconds.

#### Scenario: rejects 101st request
- **WHEN** one IP sends its 101st request within 60 seconds
- **THEN** the response status is 429
