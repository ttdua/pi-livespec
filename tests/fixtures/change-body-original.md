Base: <full SHA of the integration branch the change branch was created from, or last merged>
Branch: livespec/<change>
Initiative: #12
Depends: #34
Capabilities: new [], modified [rate-limit]
Product impact: none — <reason>
PR: #41

## Proposal
...
## Design
...
## Questions
- [ ] Q1 (blocking): Which header carries the client IP behind the proxy?
- [x] Q2 (non-blocking): ... — Answer: ...

## Units
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
