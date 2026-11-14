import { describe, expect, it } from "vitest";
import { formatResults, hasErrors, runValidate } from "../../src/commands/validate.ts";
import { makeRepo, writeIn } from "../helpers/repo.ts";

const GOOD = `# rate-limit

## Purpose
Limit requests.

## Requirements

### Requirement: Limit
The system SHALL limit requests.

#### Scenario: Over limit
- **WHEN** a client exceeds the limit
- **THEN** the request is rejected
`;

const BAD = GOOD.replace(/#### Scenario[\s\S]*$/, "");

describe("validate", () => {
	it("clean repository", async () => {
		const root = await makeRepo();
		await writeIn(root, "specs/rate-limit/spec.md", GOOD);
		const results = await runValidate(root);
		expect(results).toEqual([]);
		expect(hasErrors(results)).toBe(false);
	});

	it("error present", async () => {
		const root = await makeRepo();
		await writeIn(root, "specs/rate-limit/spec.md", BAD);
		const results = await runValidate(root);
		expect(results.some((r) => r.code === "spec-scenario-missing")).toBe(true);
		expect(hasErrors(results)).toBe(true);
		expect(formatResults(results)).toContain("spec-scenario-missing");
	});

	it("missing specs folder", async () => {
		const root = await makeRepo();
		expect(await runValidate(root)).toEqual([]);
	});

	it("free text passes through", async () => {
		const root = await makeRepo();
		await writeIn(root, "specs/product.md", "anything ### Requirement: no\n");
		await writeIn(root, "specs/constraints.md", "## whatever\n");
		await writeIn(root, "specs/bare-work.md", "garbage\n");
		expect(await runValidate(root)).toEqual([]);
	});
});
