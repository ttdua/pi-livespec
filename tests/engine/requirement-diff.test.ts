import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { createGit } from "../../src/engine/git.ts";
import { parseChange } from "../../src/core/change.ts";
import { changedIds, coversId, requirementDigests, requirementScope } from "../../src/engine/requirement-diff.ts";
import { commitAll, makeRepo, writeIn } from "../helpers/repo.ts";

const SPEC_PATH = "specs/rate-limit/spec.md";

const BASE_SPEC = [
	"## Requirements",
	"",
	"### Requirement: Per-IP cap",
	"The gateway limits each client IP to a fixed request rate",
	"over a sliding window.",
	"",
	"#### Scenario: Over the cap",
	"- **GIVEN** a client below the cap",
	"- **WHEN** it sends one more request",
	"- **THEN** the request is served",
	"",
	"### Requirement: Burst",
	"Short spikes are absorbed.",
	"",
].join("\n");

/** Commits `spec` as the living spec of `rate-limit`, then returns the repo and a digest reader bound to it. */
async function repoWith(spec: string) {
	const root = await makeRepo();
	await writeIn(root, SPEC_PATH, spec);
	commitAll(root);
	const git = createGit(root);
	const digests = () => requirementDigests(git, "HEAD", ["rate-limit"]);
	return { root, git, digests };
}

/** Commits `spec` on top of the current HEAD, so the next `digests()` reads it. */
async function editTo(root: string, spec: string): Promise<void> {
	await writeIn(root, SPEC_PATH, spec);
	commitAll(root, "edit");
}

describe("requirementScope", () => {
	test("declared plus covers capabilities, deduplicated", () => {
		const change = parseChange(
			[
				"Capabilities: new [alpha], modified [rate-limit, beta]",
				"",
				"## Units",
				"### U1 — one",
				"Covers: rate-limit/Requirement: Per-IP cap",
				"### U2 — two",
				"Covers: gamma/Requirement: Quota, rate-limit/Requirement: Burst",
			].join("\n"),
		);
		expect(requirementScope(change)).toEqual(["alpha", "beta", "gamma", "rate-limit"]);
	});
});

describe("changedIds over requirement digests", () => {
	test("text edit is a change", async () => {
		const { root, digests } = await repoWith(BASE_SPEC);
		const before = await digests();
		await editTo(root, BASE_SPEC.replace("fixed request rate", "token bucket rate"));
		expect(changedIds(before, await digests())).toEqual(["rate-limit/Requirement: Per-IP cap"]);
	});

	test("scenario THEN edit is a change", async () => {
		const { root, digests } = await repoWith(BASE_SPEC);
		const before = await digests();
		await editTo(root, BASE_SPEC.replace("the request is served", "the request is rejected"));
		expect(changedIds(before, await digests())).toEqual(["rate-limit/Requirement: Per-IP cap"]);
	});

	test("added and removed", async () => {
		const { root, digests } = await repoWith(BASE_SPEC);
		const before = await digests();
		const withoutBurst = BASE_SPEC.replace("### Requirement: Burst\nShort spikes are absorbed.\n", "### Requirement: Quota\nA daily quota applies.\n");
		await editTo(root, withoutBurst);
		expect(changedIds(before, await digests())).toEqual(["rate-limit/Requirement: Burst", "rate-limit/Requirement: Quota"]);
	});

	test("re-wrapped and re-indented text is not a change", async () => {
		const { root, digests } = await repoWith(BASE_SPEC);
		const before = await digests();
		const rewrapped = BASE_SPEC.replace(
			"The gateway limits each client IP to a fixed request rate\nover a sliding window.\n",
			"  The gateway limits each client IP to a fixed request rate over a sliding window.\n\n",
		);
		await editTo(root, rewrapped);
		expect(changedIds(before, await digests())).toEqual([]);
	});

	test("shifted lines are not a change", async () => {
		const { root, digests } = await repoWith(BASE_SPEC);
		const before = await digests();
		await editTo(root, `${"intro line\n".repeat(5)}${BASE_SPEC}`);
		expect(changedIds(before, await digests())).toEqual([]);
	});

	test("missing file at HEAD yields no digests", async () => {
		const { git } = await repoWith(BASE_SPEC);
		expect(await requirementDigests(git, "HEAD", ["no-such-capability"])).toEqual({});
	});

	test("digests are sha256 hex of requirementContent", async () => {
		const { digests } = await repoWith(BASE_SPEC);
		const map = await digests();
		const id = "rate-limit/Requirement: Burst";
		const content = JSON.stringify({ text: "Short spikes are absorbed.", scenarios: [] });
		expect(map[id]).toBe(createHash("sha256").update(content).digest("hex"));
	});

	test("requirement name with inner whitespace runs matches its coversId", async () => {
		const { digests } = await repoWith(BASE_SPEC.replace("### Requirement: Per-IP cap", "### Requirement: Per-IP  cap"));
		const map = await digests();
		expect(Object.keys(map)).toContain(coversId("rate-limit/Requirement:  Per-IP   cap"));
		expect(Object.keys(map)).toContain("rate-limit/Requirement: Per-IP cap");
	});

	test("two requirements normalizing to one id throw, naming the capability and the id", async () => {
		const duplicate = `${BASE_SPEC}\n### Requirement: Per-IP  cap\nAnother body.\n`;
		const { digests } = await repoWith(duplicate);
		await expect(digests()).rejects.toThrow(/rate-limit.*rate-limit\/Requirement: Per-IP cap/);
	});
});
