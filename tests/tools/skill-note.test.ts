import { afterEach, describe, expect, test } from "vitest";
import { parseMarked } from "../../src/forge/markers.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { BUILD_LABELS, CHANGE_BRANCH, resumeBody } from "../hooks/helpers.ts";
import { cleanupDirs, textOf, toolHarness } from "./helpers.ts";

afterEach(async () => {
	setSession(undefined);
	await cleanupDirs();
});

async function buildChange() {
	const h = await toolHarness({ branch: CHANGE_BRANCH });
	const n = await h.world.seedIssue({ title: "per-ip-cap", body: resumeBody(h.head), labels: BUILD_LABELS });
	return { ...h, n };
}

async function markers(h: Awaited<ReturnType<typeof buildChange>>) {
	const comments = await h.world.forge.listComments(h.n);
	return comments.map((c) => parseMarked(c.body)).filter((m) => m !== null);
}

describe("skill_note", () => {
	test("Note posted", async () => {
		const h = await buildChange();
		const reason = "The failing test pointed at a race in the window counter.";
		const out = await h.call("skill_note", { skill: "debugging-and-error-recovery", reason });
		expect(out.isError).toBe(false);
		expect(await markers(h)).toEqual([
			{ kind: "skill-note", id: "build.debugging-and-error-recovery", data: { phase: "build", skill: "debugging-and-error-recovery", reason } },
		]);
		// afterForgeWrite rebuilt the card: the note is now part of the state.
		const card = h.session.card;
		expect(card.kind === "change" && card.state.skillNotes).toEqual(["build.debugging-and-error-recovery"]);
	});

	test("Not optional", async () => {
		const h = await buildChange();
		const required = await h.call("skill_note", { skill: "test-driven-development", reason: "always" });
		expect(required.isError).toBe(true);
		expect(textOf(required)).toContain("not an optional skill of build");
		const elsewhere = await h.call("skill_note", { skill: "code-simplification", reason: "tidy" });
		expect(elsewhere.isError).toBe(true);
		expect(await markers(h)).toEqual([]);
	});

	test("reason longer than 200 characters is refused", async () => {
		const h = await buildChange();
		const long = await h.call("skill_note", { skill: "debugging-and-error-recovery", reason: "x".repeat(201) });
		expect(long.isError).toBe(true);
		expect(textOf(long)).toContain("1 to 200 characters");
		const multi = await h.call("skill_note", { skill: "debugging-and-error-recovery", reason: "one\ntwo" });
		expect(multi.isError).toBe(true);
		const empty = await h.call("skill_note", { skill: "debugging-and-error-recovery", reason: "  " });
		expect(empty.isError).toBe(true);
		expect(await markers(h)).toEqual([]);
		const max = await h.call("skill_note", { skill: "debugging-and-error-recovery", reason: "y".repeat(200) });
		expect(max.isError).toBe(false);
	});

	test("read-only forge refuses the note", async () => {
		const h = await buildChange();
		await h.session.refresh();
		await h.world.makeUnreachable();
		const out = await h.call("skill_note", { skill: "debugging-and-error-recovery", reason: "why" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("read-only");
		await h.world.restore();
		expect(await markers(h)).toEqual([]);
	});
});
