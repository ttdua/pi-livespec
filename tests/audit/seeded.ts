// The seeded repository of drift-audit "Drift detectors": one item of each type.

import { formatDecisionBlock } from "../../src/decide/records.ts";
import type { Forge, PullRequest, Version } from "../../src/forge/types.ts";

const RATE_LIMIT_SPEC = `---
paths:
  - src/limit/**
  - src/gone/**
---
# rate-limit

## Purpose

Limits requests per client.

## Requirements

### Requirement: Request cap
The \`RateLimiter\` SHALL reject requests over the cap; the old cap lived in \`src/limit/old.ts\` and the code is under \`src/limit/**\`.

#### Scenario: rejects 101st request
- **WHEN** a client sends 101 requests
- **THEN** the 101st is rejected

#### Scenario: allows 100 requests
- **WHEN** a client sends 100 requests
- **THEN** all are accepted
`;

const CACHE_SPEC = `---
paths:
  - src/cache/**
---
# cache

## Purpose

Caches responses.

## Requirements

### Requirement: Hit
The store SHALL serve a cached response.

#### Scenario: serves a hit
- **WHEN** a response is cached
- **THEN** it is served
`;

export function seededFiles(): Record<string, string> {
	return {
		"specs/rate-limit/spec.md": RATE_LIMIT_SPEC,
		"specs/cache/spec.md": CACHE_SPEC,
		"specs/glossary.md": "# Glossary\n\n- **Bucket**: a store of tokens.\n- **Limiter**: the request gate.\n",
		"specs/product.md": "# Product\n\nThe rate-limit capability protects the API.\nIts design follows 0002-x.\n",
		"specs/decisions/0002-x.md": "---\nstatus: superseded\nsuperseded_by: 5\n---\n# 0002-x\n\nUse a fixed window.\n",
		"specs/decisions/0005-y.md": "---\nstatus: accepted\n---\n# 0005-y\n\nUse a sliding window; 0002-x is superseded.\n",
		"src/limit/cap.ts": "// The request Limiter.\nexport class RateLimiter {}\n",
		"src/cache/store.ts": "export const store = new Map();\n",
		"tests/limit.test.ts": 'it("allows 100 requests", () => {});\n',
		"tests/cache.test.ts": 'it("serves a hit", () => {});\n',
	};
}

export function pullRequest(n: number, head: string, body: string): PullRequest {
	return { number: n, state: "closed", merged: true, head, base: "main", title: `pr ${n}`, body, author: "alice", version: "v1" as Version };
}

export function laneBody(capabilities: string[]): string {
	return `Fixes the cap.\n\n${formatDecisionBlock("lane", {
		point: "lane",
		subject: "fix/tweak",
		source: "rule",
		outcome: { lane: "small", reasons: [], behavior_change: "declared-none", capabilities },
		reason: "small fix",
	})}\n`;
}

export function forgeOf(prs: PullRequest[]): Pick<Forge, "getPullRequest"> {
	return {
		async getPullRequest(n) {
			const pr = prs.find((p) => p.number === n);
			if (!pr) throw new Error(`no pull request #${n}`);
			return pr;
		},
	};
}

export function seededFixes(): { commits: { sha: string; subject: string }[]; forge: Pick<Forge, "getPullRequest"> } {
	return {
		commits: [{ sha: "a".repeat(40), subject: "fix: tweak (#7)" }],
		forge: forgeOf([pullRequest(7, "fix/tweak", laneBody(["rate-limit"]))]),
	};
}
