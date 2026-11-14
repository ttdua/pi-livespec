Base: 0123456789abcdef0123456789abcdef01234567
Branch: livespec/per-ip-cap
Initiative: #12
Depends: #34
Capabilities: new [], modified [rate-limit]
Product impact: none — internal limit only
PR: #41

## Proposal
Limit each client IP.
## Design
Sliding window counter in memory.

## Questions
- [ ] Q1 (blocking): Which header carries the client IP behind the proxy?
- [x] Q2 (non-blocking): Should the window be configurable? — Answer: yes

## Units
### U1 — Request context
Covers: request-context/Requirement: Client IP
Difficulty: low
Tags: []
Files: src/context.ts, test/context.test.ts
Done means:
- [ip] the client IP is available on the request context
Scenarios:
- [ip] test/context.test.ts › exposes client IP
Depends: —
Verify: `npm test -- context`
- [x] done

### U3 — Rate limit per IP
Covers: rate-limit/Requirement: Per-IP cap
Difficulty: medium
Tags: [security, api]
Files: src/middleware/ratelimit.ts, test/ratelimit.test.ts
Done means:
- [cap] the 101st request within 60 s from one IP gets 429
Scenarios:
- [cap] test/ratelimit.test.ts › rejects 101st request
Depends: U1
Verify: `npm test -- ratelimit`
- [ ] pending

## Durable docs
| File | Status |
|---|---|
| specs/<capability>/spec.md | updated |
| specs/product.md | not needed — <reason> |
| specs/glossary.md | not needed — <reason> |
| specs/constraints.md | not needed — <reason> |
| specs/decisions/ | not needed — <reason> |
