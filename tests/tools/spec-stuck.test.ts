import { afterEach, describe, expect, test } from "vitest";
import { pickByLabel } from "../helpers/menu.ts";
import { filterMarked, type MarkedComment, writeMarked } from "../../src/forge/markers.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import type { FakeUI } from "../hooks/fake-pi.ts";
import { CHANGE_BRANCH, resumeBody } from "../hooks/helpers.ts";
import { cleanupDirs, textOf, type ToolHarness, toolHarness } from "./helpers.ts";

afterEach(async () => {
	setSession(undefined);
	await cleanupDirs();
});

const FORGE_CHAIN = "integrationBranch: main\ninteraction: { adapter: [forge] }\n";
const SESSION_CHAIN = "integrationBranch: main\ninteraction: { adapter: [in-session] }\n";
const OPTIONS = [
	{ id: "A", label: "split U3", description: "Cut the unit in two and review each part" },
	{ id: "B", label: "re-plan", description: "Go back to plan and rewrite the units" },
	{ id: "C", label: "drop the cap", description: "Lift the iteration cap for this unit" },
];
const REPORT = {
	where: "U3 rate limiter keeps failing review",
	tried: [{ text: "sliding window", link: "https://example.test/pr/41" }, { text: "token bucket" }],
	hypothesis: "the requirement mixes two limits",
	options: OPTIONS,
	recommended: "A",
	rationale: "Splitting keeps both limits testable.",
};

type Stuck = ToolHarness & { n: number; stuck(params: unknown): ReturnType<ToolHarness["call"]> };

async function change(o: { config?: string; ui?: FakeUI } = {}): Promise<Stuck> {
	const h = await toolHarness({ branch: CHANGE_BRANCH, ...(o.config ? { config: o.config } : {}), ...(o.ui ? { ui: o.ui } : {}) });
	const n = await h.world.seedIssue({ title: "per-ip-cap", body: resumeBody(h.head), labels: ["livespec", "livespec:phase/build"] });
	await h.session.refresh();
	return { ...h, n, stuck: (params) => h.call("spec_stuck", params) };
}

async function marked(h: Stuck): Promise<MarkedComment[]> {
	return filterMarked(await h.world.forge.listComments(h.n), BOT_LOGIN).comments;
}
const ofKind = async (h: Stuck, kind: string) => (await marked(h)).filter((m) => m.kind === kind);

function card(h: Stuck) {
	const c = h.session.card;
	if (c.kind !== "change") throw new Error(`no change card: ${c.kind}`);
	return c;
}

async function seedCascades(h: Stuck, from: number, count: number): Promise<void> {
	for (let i = from; i < from + count; i++) {
		await h.world.postComment(h.n, BOT_LOGIN, writeMarked("stale", `Q${i}`, { reason: `Q${i}`, phases: ["define"], units: [], after_plan: true }));
	}
	await h.session.comments?.invalidate(h.n);
	await h.session.refresh();
}

const CAP_NEXT = "Send a stuck report with spec_stuck: change_iterations reached";

describe("spec_stuck", () => {
	test("Stuck report waits for a choice", async () => {
		const h = await change({ config: FORGE_CHAIN });
		const out = await h.stuck(REPORT);
		expect(out.isError).toBe(false);
		const stuck = await ofKind(h, "stuck");
		expect(stuck).toHaveLength(1);
		expect(stuck[0]).toMatchObject({ id: "S1", data: REPORT });
		const requests = await ofKind(h, "request");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.data).toMatchObject({ kind: "stuck", subject: "stuck:S1", mode: "blocking", options: OPTIONS, snapshot: { id: "S1" } });
		expect(card(h).step.next).toBe("Wait for the human's choice on stuck report S1.");
		expect(card(h).step.pending).toEqual([expect.objectContaining({ subject: "stuck:S1", mode: "blocking", adapter: "forge" })]);
	});

	test("Option count enforced", async () => {
		const h = await change({ config: FORGE_CHAIN });
		for (const options of [[OPTIONS[0]!], [...OPTIONS, { id: "D", label: "wait" }]]) {
			const out = await h.stuck({ ...REPORT, options });
			expect(out.isError).toBe(true);
			expect(textOf(out)).toContain("two or three options");
		}
		expect(await marked(h)).toEqual([]);
	});

	test("recommended must be one of the options", async () => {
		const h = await change({ config: FORGE_CHAIN });
		const out = await h.stuck({ ...REPORT, recommended: "Z" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("recommended");
		const dup = await h.stuck({ ...REPORT, options: [OPTIONS[0]!, OPTIONS[0]!] });
		expect(dup.isError).toBe(true);
		expect(await marked(h)).toEqual([]);
	});

	test("Option without a description", async () => {
		const h = await change({ config: FORGE_CHAIN });
		const out = await h.stuck({ ...REPORT, options: [{ id: "A", label: "split U3" }, OPTIONS[1]!] });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("option A description is required");
		expect(await marked(h)).toEqual([]);
	});

	test("rationale is required", async () => {
		const h = await change({ config: FORGE_CHAIN });
		const { rationale: _omit, ...without } = REPORT;
		const out = await h.stuck(without);
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("rationale");
		expect(await marked(h)).toEqual([]);
	});

	test("hypothesis over 600 code points is refused", async () => {
		const h = await change({ config: FORGE_CHAIN });
		const out = await h.stuck({ ...REPORT, hypothesis: "x".repeat(601) });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("hypothesis");
		expect(textOf(out)).toContain("at most 600");
		expect(await marked(h)).toEqual([]);
	});

	test("Recommended choice not offered", async () => {
		const h = await change({ config: FORGE_CHAIN });
		const out = await h.stuck({ ...REPORT, recommended: "C2" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("recommended");
		expect(await marked(h)).toEqual([]);
	});

	test("Option description neutralised", async () => {
		const h = await change({ config: FORGE_CHAIN });
		const options = [{ ...OPTIONS[0]!, description: "see <!-- x --> now" }, OPTIONS[1]!];
		await h.stuck({ ...REPORT, options });
		const request = (await ofKind(h, "request"))[0]?.data as { options: { description: string }[]; briefing: { rationale: string; author: string } };
		expect(request.options[0]?.description).not.toContain("<!--");
		expect(request.briefing).toMatchObject({ rationale: REPORT.rationale, author: "agent" });
	});

	test("Old stuck report sent again", async () => {
		const h = await change({ config: FORGE_CHAIN });
		const old = { where: REPORT.where, tried: REPORT.tried, hypothesis: REPORT.hypothesis, options: [{ id: "A", label: "split U3" }, { id: "B", label: "re-plan" }], recommended: "A" };
		await h.world.postComment(h.n, BOT_LOGIN, writeMarked("stuck", "S1", old));
		await h.session.comments?.invalidate(h.n);
		await h.session.refresh();
		const out = await h.stuck(REPORT);
		expect(out.isError).toBe(false);
		const data = (await ofKind(h, "request"))[0]?.data as { summary: string; options: { id: string; description?: string }[]; briefing?: unknown };
		expect(data.summary).toContain("Recommended: A");
		expect(data.options.map((o) => o.description)).toEqual(["Option A of stuck report S1.", "Option B of stuck report S1."]);
		expect(data.briefing).toMatchObject({ summary: REPORT.hypothesis, recommended: "A", rationale: "Recommended in stuck report S1.", author: "agent" });
	});

	test("Recommendation is not an answer", async () => {
		const ui: FakeUI = { hasUI: true, select: async () => undefined };
		const h = await change({ config: SESSION_CHAIN, ui });
		await h.stuck(REPORT);
		const answer = (await ofKind(h, "stuck")).find((m) => m.id === "S1-answer");
		expect(answer?.data).toMatchObject({ outcome: "dismissed" });
		expect((answer?.data as { choice?: string }).choice).toBe("");
	});

	test("Stuck answer lifts the cap", async () => {
		const ui: FakeUI = { hasUI: true, select: async (_title, options) => pickByLabel(options, "re-plan") };
		const h = await change({ config: SESSION_CHAIN, ui });
		await seedCascades(h, 1, 5);
		expect(card(h).step.next).toContain(CAP_NEXT);
		const out = await h.stuck(REPORT);
		expect(out.isError).toBe(false);
		expect((await ofKind(h, "stuck")).find((m) => m.id === "S1-answer")?.data).toMatchObject({ choice: "B", outcome: "approved", adapter: "in-session" });
		expect(card(h).step.next).not.toContain(CAP_NEXT);
		expect(card(h).state.iterations.blocking).toBe(false);
		await seedCascades(h, 6, 1);
		expect(card(h).step.next).toBe(`${CAP_NEXT} 6 of 5.`);
		// The next report gets the next free id.
		await h.stuck(REPORT);
		expect((await ofKind(h, "stuck")).map((m) => m.id)).toEqual(["S1", "S1-answer", "S2", "S2-answer"]);
	});

	test("an open report without a request is sent again unchanged", async () => {
		const h = await change({ config: FORGE_CHAIN });
		await h.world.postComment(h.n, BOT_LOGIN, writeMarked("stuck", "S1", REPORT));
		await h.session.comments?.invalidate(h.n);
		await h.session.refresh();
		const out = await h.stuck({ ...REPORT, where: "somewhere else" });
		expect(out.isError).toBe(false);
		expect(textOf(out)).toContain("stuck report S1 already exists and was sent again unchanged; the new parameters were not used");
		expect((await ofKind(h, "stuck")).map((m) => m.id)).toEqual(["S1"]);
		expect((await ofKind(h, "request"))[0]?.data).toMatchObject({ subject: "stuck:S1" });
		expect(String((await ofKind(h, "request"))[0]?.data && ((await ofKind(h, "request"))[0]!.data as { summary: string }).summary)).toContain(REPORT.where);
	});

	test("a second report waits while one is unanswered", async () => {
		const h = await change({ config: FORGE_CHAIN });
		await h.stuck(REPORT);
		const out = await h.stuck(REPORT);
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("S1");
		expect((await ofKind(h, "stuck")).map((m) => m.id)).toEqual(["S1"]);
	});

	test("an open stored report with long or multi-line option texts is sent again", async () => {
		const h = await change({ config: FORGE_CHAIN });
		const stored = { ...REPORT, options: [{ id: "A", label: "split\nU3", description: "d".repeat(300) }, OPTIONS[1]!] };
		await h.world.postComment(h.n, BOT_LOGIN, writeMarked("stuck", "S1", stored));
		await h.session.comments?.invalidate(h.n);
		await h.session.refresh();
		const out = await h.stuck(REPORT);
		expect(out.isError, textOf(out)).toBe(false);
		expect(await ofKind(h, "request")).toHaveLength(1);
	});

	test("a try link is stored neutralised", async () => {
		const h = await change({ config: FORGE_CHAIN });
		await h.stuck({ ...REPORT, tried: [{ text: "x", link: "see <!-- livespec:gate:plan -->" }] });
		const data = (await ofKind(h, "stuck"))[0]?.data as { tried: { link?: string }[] };
		expect(data.tried[0]?.link).not.toContain("<!--");
	});
});
