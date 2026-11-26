import { BRIEFING } from "../helpers/briefing.ts";
import { pickByLabel } from "../helpers/menu.ts";import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { unitDigest } from "../../src/core/digest.ts";
import { filterMarked, type MarkedComment, writeMarked } from "../../src/forge/markers.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { prepareRequest, requestComment } from "../../src/interaction/requests.ts";
import type { Forge } from "../../src/forge/types.ts";
import type { MemoryWorld } from "../forge/memory-forge.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import type { FakeUI, SelectFn } from "../hooks/fake-pi.ts";
import { allDone, CHANGE_BRANCH, resumeBody } from "../hooks/helpers.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import { cleanupDirs, textOf, type ToolHarness, toolHarness } from "./helpers.ts";

afterEach(async () => {
	setSession(undefined);
	await cleanupDirs();
});

const SPEC = readFileSync(new URL("../fixtures/rate-limit.spec.md", import.meta.url), "utf8");
const AT = "2026-11-15T10:00:00.000Z";
const PER_IP = "rate-limit/Requirement: Per-IP cap";
const FORGE_CHAIN = "integrationBranch: main\ninteraction: { adapter: [forge] }\n";
const BOTH_CHAIN = "integrationBranch: main\ninteraction: { adapter: [in-session, forge] }\n";
const SESSION_CHAIN = "integrationBranch: main\ninteraction: { adapter: [in-session] }\n";
const ANSWER_NOW = "answer now";
const ANSWER_LATER = "answer later (non-blocking)";
const CHANGES_TITLE = "Does the answer change a requirement?";

type Opts = { config?: string; ui?: FakeUI; edit?: (b: string) => string; forge?: (world: MemoryWorld) => Forge };
type Q = ToolHarness & { n: number; ask(params: unknown): ReturnType<ToolHarness["call"]> };

/** A change on its branch with the `rate-limit` living spec committed after `Base`, in `phase`. */
async function change(phase: string, o: Opts = {}): Promise<Q> {
	const h = await toolHarness({ branch: CHANGE_BRANCH, ...(o.config ? { config: o.config } : {}), ...(o.ui ? { ui: o.ui } : {}), ...(o.forge ? { forge: o.forge } : {}) });
	const base = h.git("rev-parse", "HEAD");
	await writeIn(h.root, "specs/rate-limit/spec.md", SPEC);
	commitAll(h.root, "spec");
	const body = (o.edit ?? ((b: string) => b))(resumeBody(base));
	const n = await h.world.seedIssue({ title: "per-ip-cap", body, labels: ["livespec", `livespec:phase/${phase}`] });
	await h.session.refresh();
	return { ...h, n, ask: (params) => h.call("spec_question", params) };
}

/** A scripted in-session human: answer now or later, an answer text, and the changed requirement ("no" by default). */
type Script = { later?: boolean; cancel?: boolean; answer?: string; changes?: string; typed?: string };
function human(s: Script): FakeUI {
	const select: SelectFn = async (title, options) => {
		if (title === CHANGES_TITLE) {
			if (s.typed !== undefined) return "other";
			return s.changes === undefined ? "no" : options.find((o) => o === s.changes);
		}
		if (s.cancel) return undefined;
		return s.later ? ANSWER_LATER : ANSWER_NOW;
	};
	const input = async (title: string) => (title === "Changed requirement" ? s.typed : s.answer);
	return { hasUI: true, select, input };
}

async function marked(h: Q): Promise<MarkedComment[]> {
	return filterMarked(await h.world.forge.listComments(h.n), BOT_LOGIN).comments;
}
const ofKind = async (h: Q, kind: string) => (await marked(h)).filter((m) => m.kind === kind);
const questions = async (h: Q) => parseChange(await h.world.bodyOf(h.n)).questions;
const lineOf = async (h: Q, id: string) => (await h.world.bodyOf(h.n)).split("\n").find((l) => l.includes(` ${id} (`));

function card(h: Q) {
	const c = h.session.card;
	if (c.kind !== "change") throw new Error(`no change card: ${c.kind}`);
	return c;
}

async function phaseLabels(h: Q): Promise<string[]> {
	return (await h.world.forge.getIssue(h.n)).labels.filter((l) => l.startsWith("livespec:phase/"));
}

async function seedMarked(h: Q, body: string): Promise<void> {
	await h.world.postComment(h.n, BOT_LOGIN, body);
	await h.session.comments?.invalidate(h.n);
}

/** An approved plan gate that locks the current units. */
async function lockPlan(h: Q): Promise<void> {
	const locked = Object.fromEntries(parseChange(await h.world.bodyOf(h.n)).units.map((u) => [u.id, unitDigest(u)]));
	const data = { phase: "plan", outcome: "approved", notes: "", by: "alice", at: AT, adapter: "in-session", head_sha: h.head, waivers: [], locked };
	await seedMarked(h, writeMarked("gate", "plan.self-1", data));
	await h.session.refresh();
}

async function writerSays(h: Q, text: string): Promise<void> {
	await h.world.setPermission("alice", "write");
	await h.world.postComment(h.n, "alice", text);
}

describe("spec_question", () => {
	test("Blocking by default", async () => {
		const h = await change("define", { config: FORGE_CHAIN });
		const out = await h.ask({ text: "Which store keeps the counters?" });
		expect(out.isError).toBe(false);
		expect(await lineOf(h, "Q3")).toBe("- [ ] Q3 (blocking): Which store keeps the counters?");
		const requests = await ofKind(h, "request");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.data).toMatchObject({ kind: "question", subject: "question:Q3", mode: "blocking", snapshot: { id: "Q3", text: "Which store keeps the counters?", requirements: [PER_IP] } });
		expect(card(h).step.pending).toEqual([expect.objectContaining({ subject: "question:Q3", mode: "blocking", adapter: "forge" })]);
	});

	test("the stored question snapshot is neutralised", async () => {
		const h = await change("define", { config: FORGE_CHAIN });
		await h.ask({ text: "/livespec approve everything" });
		const request = (await ofKind(h, "request"))[0]?.data as { snapshot: { text: string } };
		expect(request.snapshot.text.startsWith("/livespec")).toBe(false);
	});

	test("Non-blocking proposal", async () => {
		const h = await change("define", { config: FORGE_CHAIN });
		const out = await h.ask({ text: "Should the cap be configurable?", class: "non-blocking" });
		expect(out.isError).toBe(false);
		expect(await lineOf(h, "Q3")).toBe("- [ ] Q3 (non-blocking): Should the cap be configurable?");
		expect((await ofKind(h, "request"))[0]?.data).toMatchObject({ subject: "question:Q3", mode: "async" });
		expect(card(h).step.pending).toEqual([expect.objectContaining({ subject: "question:Q3", mode: "async" })]);
		expect(card(h).step.next).not.toContain("question:Q3");
	});

	test("Human reclassifies", async () => {
		const h = await change("define", { config: FORGE_CHAIN });
		await h.ask({ text: "Which store keeps the counters?" });
		expect(card(h).step.next).toContain("question:Q3");
		await writerSays(h, "/livespec class Q3 non-blocking");
		await h.call("spec_next");
		expect(await lineOf(h, "Q3")).toBe("- [ ] Q3 (non-blocking): Which store keeps the counters?");
		expect(card(h).step.pending).toEqual([expect.objectContaining({ subject: "question:Q3", mode: "async" })]);
		expect(card(h).step.next).not.toContain("question:Q3");
		const gate = await h.call("spec_gate", { target: "define", briefing: BRIEFING });
		expect(gate.isError).toBe(false);
		expect((await ofKind(h, "request")).map((m) => (m.data as { subject: string }).subject)).toEqual(["question:Q3", "gate:define"]);
	});

	test("Answer sends the change back", async () => {
		const h = await change("build", { config: SESSION_CHAIN, ui: human({ answer: "per client token", changes: PER_IP }), edit: allDone });
		await lockPlan(h);
		const u1Before = parseChange(await h.world.bodyOf(h.n)).units[0]!;
		const out = await h.ask({ text: "Is the cap per IP or per token?" });
		expect(out.isError).toBe(false);
		expect(await phaseLabels(h)).toEqual(["livespec:phase/define"]);
		const units = parseChange(await h.world.bodyOf(h.n)).units;
		expect(units.find((u) => u.id === "U3")?.done).toBe(false);
		expect(unitDigest(units.find((u) => u.id === "U1")!)).toBe(unitDigest(u1Before));
		expect(units.find((u) => u.id === "U1")?.done).toBe(true);
		expect(card(h).state.lock.staleUnits).toEqual(["U3"]);
		expect(card(h).state.counters.change_iterations).toBe(1);
		expect(await lineOf(h, "Q3")).toBe("- [x] Q3 (blocking): Is the cap per IP or per token? — Answer: per client token");
		// The requirement list came from the declared capability's living spec.
		const changes = h.ctx.ui.select.mock.calls.find((c) => c[0] === CHANGES_TITLE);
		expect(changes?.[1]).toEqual(["no", PER_IP, "other"]);
	});

	test("Cascade before the plan", async () => {
		const h = await change("define", { config: SESSION_CHAIN, ui: human({ answer: "per token", changes: PER_IP }) });
		await h.ask({ text: "Is the cap per IP or per token?" });
		const stale = await ofKind(h, "stale");
		expect(stale).toHaveLength(1);
		expect(stale[0]).toMatchObject({ id: "Q3", data: { after_plan: false } });
		expect(card(h).state.counters.change_iterations).toBe(0);
	});

	test("Second answer while in define", async () => {
		const ui = human({ answer: "per token", changes: PER_IP });
		const h = await change("build", { config: SESSION_CHAIN, ui, edit: allDone });
		await lockPlan(h);
		await h.ask({ text: "Is the cap per IP or per token?" });
		expect(card(h).state.counters.change_iterations).toBe(1);
		const second = human({ answer: "use X-Real-IP", typed: "request-context/Requirement: Client IP" });
		h.ctx.ui.select.mockImplementation(second.select!);
		h.ctx.ui.input.mockImplementation(second.input!);
		const out = await h.ask({ text: "Which header carries the IP?" });
		expect(out.isError).toBe(false);
		const stale = await ofKind(h, "stale");
		expect(stale.map((m) => m.id)).toEqual(["Q3", "Q4"]);
		expect(stale[1]?.data).toMatchObject({ after_plan: false });
		expect(card(h).state.counters.change_iterations).toBe(1);
	});

	test("Cap reached", async () => {
		const h = await change("define", { config: SESSION_CHAIN });
		for (let i = 1; i <= 5; i++) {
			await seedMarked(h, writeMarked("stale", `Q${10 + i}`, { reason: `Q${10 + i}`, phases: ["define"], units: [], after_plan: true }));
		}
		await h.session.refresh();
		expect(card(h).step.next).toBe("Send a stuck report with spec_stuck: change_iterations reached 5 of 5.");
		const gate = await h.call("spec_gate", { target: "define", briefing: BRIEFING });
		expect(gate.isError).toBe(true);
		expect(textOf(gate)).toContain("spec_stuck");
	});

	test("dismissed question stays open", async () => {
		const h = await change("define", { config: SESSION_CHAIN, ui: human({ cancel: true }) });
		const out = await h.ask({ text: "Which store keeps the counters?" });
		expect(out.isError).toBe(false);
		expect(await lineOf(h, "Q3")).toBe("- [ ] Q3 (blocking): Which store keeps the counters?");
		expect((await ofKind(h, "question"))[0]?.data).toMatchObject({ answer: "", by: BOT_LOGIN, adapter: "in-session" });
		expect(card(h).step.blockingQuestions.map((q) => q.id)).toEqual(["Q3"]);
	});

	test("reask sends an open question again", async () => {
		const h = await change("define", { config: FORGE_CHAIN });
		await h.ask({ text: "Which store keeps the counters?" });
		const busy = await h.ask({ reask: "Q3" });
		expect(busy.isError).toBe(true);
		expect(textOf(busy)).toContain("pending");
		await writerSays(h, "/livespec dismiss later");
		await h.call("spec_next");
		expect(card(h).step.pending).toEqual([]);
		const out = await h.ask({ reask: "Q3" });
		expect(out.isError).toBe(false);
		expect((await questions(h)).filter((q) => q.id === "Q3")).toHaveLength(1);
		expect(card(h).step.pending).toEqual([expect.objectContaining({ subject: "question:Q3", mode: "blocking" })]);
		const answered = await h.ask({ reask: "Q2" });
		expect(answered.isError).toBe(true);
		expect(textOf(answered)).toContain("Q2 is answered");
		const missing = await h.ask({ reask: "Q9" });
		expect(missing.isError).toBe(true);
	});

	test("a malformed reask is refused without a write", async () => {
		const h = await change("define", { config: FORGE_CHAIN });
		const before = (await h.world.forge.listComments(h.n)).length;
		const out = await h.ask({ reask: "not-an-id" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("not-an-id");
		expect((await h.world.forge.listComments(h.n)).length).toBe(before);
	});

	test("Answer later in session", async () => {
		const forge = await change("define", { config: BOTH_CHAIN, ui: human({ later: true }) });
		const out = await forge.ask({ text: "Which store keeps the counters?" });
		expect(out.isError).toBe(false);
		expect(card(forge).state.change.questions.find((q) => q.id === "Q3")?.kind).toBe("non-blocking");
		expect((await ofKind(forge, "request"))[0]?.data).toMatchObject({ subject: "question:Q3", mode: "async" });
		expect(card(forge).step.pending).toEqual([expect.objectContaining({ subject: "question:Q3", mode: "async", adapter: "forge" })]);

		const alone = await change("define", { config: SESSION_CHAIN, ui: human({ later: true }) });
		const later = await alone.ask({ text: "Which store keeps the counters?" });
		expect(later.isError).toBe(false);
		expect(textOf(later)).toContain("reask");
		expect(card(alone).state.change.questions.find((q) => q.id === "Q3")).toMatchObject({ kind: "non-blocking", checked: false });
		expect(await ofKind(alone, "request")).toEqual([]);
		expect(card(alone).step.pending).toEqual([]);
	});

	test("a question added but not sent names reask", async () => {
		const h = await change("define", { config: SESSION_CHAIN });
		const out = await h.ask({ text: "Which store keeps the counters?" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain('Q3 was added to ## Questions but not sent: ');
		expect(textOf(out)).toContain('send it with spec_question { reask: "Q3" }');
		expect((await questions(h)).map((q) => q.id)).toEqual(["Q1", "Q2", "Q3"]);
		expect(await ofKind(h, "request")).toEqual([]);
	});

	test("a duplicate request after the append names reask", async () => {
		const h = await change("define", { config: FORGE_CHAIN });
		// A pending forge request for question:Q3 already exists, so sending the new Q3 is a duplicate.
		await seedMarked(h, requestComment("question-Q3.lx0", prepareRequest({ kind: "question", subject: "question:Q3", mode: "blocking", head: h.head, body: "", snapshot: { id: "Q3", text: "old", requirements: [] }, summary: "old", now: new Date(Date.UTC(2026, 0, 1)) }), "plain"));
		await h.session.refresh();
		const out = await h.ask({ text: "Which store keeps the counters?" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain('Q3 was added to ## Questions but not sent: ');
		expect(textOf(out)).toContain('reask: "Q3"');
		expect((await questions(h)).map((q) => q.id)).toEqual(["Q1", "Q2", "Q3"]);
	});

	test("answer later retries the reclassification once after a version conflict", async () => {
		let conflicts = 0;
		const h: Q = await change("define", {
			config: BOTH_CHAIN,
			ui: human({ later: true }),
			forge: (world) =>
				new Proxy(world.forge, {
					get(target, prop, receiver) {
						if (prop !== "updateIssueBody") return Reflect.get(target, prop, receiver);
						return async (n: number, body: string, expect: never) => {
							if (conflicts === 0 && body.includes("Q3 (non-blocking)")) {
								conflicts++;
								await world.editBodyBehindBack(n, (await world.bodyOf(n)).replace("Limit each client IP.", "Limit each client IP address."));
							}
							return target.updateIssueBody(n, body, expect);
						};
					},
				}),
		});
		const out = await h.ask({ text: "Which store keeps the counters?" });
		expect(conflicts).toBe(1);
		expect(out.isError).toBe(false);
		const body = await h.world.bodyOf(h.n);
		expect(body).toContain("- [ ] Q3 (non-blocking): Which store keeps the counters?");
		expect(body).toContain("Limit each client IP address.");
		expect((await ofKind(h, "request"))[0]?.data).toMatchObject({ subject: "question:Q3", mode: "async" });
	});

	test("text must be one line and exactly one of text or reask is given", async () => {
		const h = await change("define", { config: FORGE_CHAIN });
		const before = await h.world.bodyOf(h.n);
		for (const params of [{ text: "two\nlines" }, {}, { text: "x", reask: "Q1" }, { text: "   " }]) {
			const out = await h.ask(params);
			expect(out.isError).toBe(true);
		}
		expect(await h.world.bodyOf(h.n)).toBe(before);
		expect(await ofKind(h, "request")).toEqual([]);
	});
});

const CANDS = [
	{ label: "Redis", description: "Shared counters across instances." },
	{ label: "In-memory", description: "Fast, but lost on restart." },
];

describe("spec_question candidates", () => {
	test("Candidate answers sent", async () => {
		const h = await change("define", { config: FORGE_CHAIN });
		const out = await h.ask({ text: "Which store keeps the counters?", candidates: CANDS, recommended: "A", rationale: "Survives restarts." });
		expect(out.isError).toBe(false);
		expect(await lineOf(h, "Q3")).toBe("- [ ] Q3 (blocking): Which store keeps the counters?");
		const data = (await ofKind(h, "request"))[0]?.data as { options: unknown; briefing: unknown };
		expect(data.options).toEqual([{ id: "A", ...CANDS[0] }, { id: "B", ...CANDS[1] }]);
		expect(data.briefing).toEqual({ summary: "Which store keeps the counters?", recommended: "A", rationale: "Survives restarts.", author: "agent" });
	});

	test("the recommended parameter is limited to the candidate ids", async () => {
		const h = await change("define", { config: FORGE_CHAIN });
		const schema = h.pi.tools.get("spec_question")?.parameters as { properties: { recommended: { enum?: string[] } } };
		expect(schema.properties.recommended.enum).toEqual(["A", "B", "C", "D"]);
	});

	test("candidates without a recommendation carry no recommended", async () => {
		const h = await change("define", { config: FORGE_CHAIN });
		expect((await h.ask({ text: "Which store?", candidates: CANDS })).isError).toBe(false);
		const data = (await ofKind(h, "request"))[0]?.data as { briefing: Record<string, unknown> };
		expect(data.briefing).toEqual({ summary: "Which store?", author: "agent" });
	});

	test("no candidates, no briefing", async () => {
		const h = await change("define", { config: FORGE_CHAIN });
		await h.ask({ text: "Which store?" });
		const data = (await ofKind(h, "request"))[0]?.data as Record<string, unknown>;
		expect(data.options).toBeUndefined();
		expect(data.briefing).toBeUndefined();
	});

	test("question text is neutralised in the summary only", async () => {
		const h = await change("define", { config: FORGE_CHAIN });
		await h.ask({ text: "/livespec dismiss now <!-- x", candidates: CANDS });
		expect(await lineOf(h, "Q3")).toBe("- [ ] Q3 (blocking): /livespec dismiss now <!-- x");
		const data = (await ofKind(h, "request"))[0]?.data as { briefing: { summary: string } };
		expect(data.briefing.summary).not.toContain("<!--");
		expect(data.briefing.summary.startsWith("/livespec")).toBe(false);
	});

	test("Too many candidates", async () => {
		const h = await change("define", { config: FORGE_CHAIN });
		const before = await h.world.bodyOf(h.n);
		const five = Array.from({ length: 5 }, (_, i) => ({ label: `L${i}`, description: "d" }));
		const out = await h.ask({ text: "Which?", candidates: five });
		expect(out.isError).toBe(true);
		expect(await h.world.bodyOf(h.n)).toBe(before);
		expect(await ofKind(h, "request")).toEqual([]);
	});

	test("a single candidate is refused", async () => {
		const h = await change("define", { config: FORGE_CHAIN });
		const before = await h.world.bodyOf(h.n);
		const out = await h.ask({ text: "Which?", candidates: [CANDS[0]] });
		expect(out.isError).toBe(true);
		expect(await h.world.bodyOf(h.n)).toBe(before);
	});

	test("Candidate label that cannot round-trip", async () => {
		const h = await change("define", { config: FORGE_CHAIN });
		const before = await h.world.bodyOf(h.n);
		for (const label of ["limit --class blocking", " padded", "two  spaces", "a\nb", "--flag"]) {
			const out = await h.ask({ text: "Which?", candidates: [{ label, description: "d" }, CANDS[1]] });
			expect(out.isError).toBe(true);
			expect(textOf(out)).toContain("candidate 1");
		}
		expect(await h.world.bodyOf(h.n)).toBe(before);
		expect(await ofKind(h, "request")).toEqual([]);
	});

	test("duplicate labels, missing descriptions and unknown recommended are refused", async () => {
		const h = await change("define", { config: FORGE_CHAIN });
		const before = await h.world.bodyOf(h.n);
		const bad: unknown[] = [
			{ candidates: [CANDS[0], { label: "Redis", description: "again" }] },
			{ candidates: [{ label: "X" }, CANDS[1]] },
			{ candidates: CANDS, recommended: "C", rationale: "r" },
			{ candidates: CANDS, recommended: "A" },
			{ candidates: CANDS, rationale: "r" },
			{ recommended: "A", rationale: "r" },
			{ rationale: "r" },
		];
		for (const extra of bad) expect((await h.ask({ text: "Which?", ...(extra as object) })).isError).toBe(true);
		expect(await h.world.bodyOf(h.n)).toBe(before);
	});

	test("Summary too long", async () => {
		const h = await change("define", { config: FORGE_CHAIN });
		const before = await h.world.bodyOf(h.n);
		const out = await h.ask({ text: "Which?", candidates: CANDS, recommended: "A", rationale: "x".repeat(601) });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("at most 600");
		expect(await h.world.bodyOf(h.n)).toBe(before);
	});

	test("reask with new candidates sends them", async () => {
		const h = await change("define", { config: FORGE_CHAIN });
		await h.ask({ text: "Which store keeps the counters?" });
		await writerSays(h, "/livespec dismiss later");
		await h.call("spec_next");
		const out = await h.ask({ reask: "Q3", candidates: CANDS, recommended: "B", rationale: "Simple." });
		expect(out.isError).toBe(false);
		const requests = await ofKind(h, "request");
		const data = requests[requests.length - 1]?.data as { options: unknown; briefing: { recommended: string } };
		expect(data.options).toEqual([{ id: "A", ...CANDS[0] }, { id: "B", ...CANDS[1] }]);
		expect(data.briefing.recommended).toBe("B");
	});

	test("in-session pick answers with exactly the label", async () => {
		const seen: string[][] = [];
		const ui: FakeUI = {
			hasUI: true,
			select: async (title, options) => {
				if (title === CHANGES_TITLE) return "no";
				seen.push(options);
				return pickByLabel(options, "In-memory");
			},
			input: async () => undefined,
		};
		const h = await change("define", { config: SESSION_CHAIN, ui });
		const out = await h.ask({ text: "Which store keeps the counters?", candidates: CANDS });
		expect(out.isError).toBe(false);
		expect(seen[0]?.some((o) => o.startsWith("Redis"))).toBe(true);
		expect((await ofKind(h, "question"))[0]?.data).toMatchObject({ answer: "In-memory", adapter: "in-session" });
	});

	test("the prefilled forge command answers with exactly the label", async () => {
		const h = await change("define", { config: FORGE_CHAIN });
		await h.ask({ text: "Which store keeps the counters?", candidates: CANDS });
		const text = (await h.world.forge.listComments(h.n)).map((c) => c.body).find((b) => b.includes("### How to answer")) ?? "";
		const row = text.split("\n").find((l) => l.startsWith("| ") && l.split(" | ")[0]?.includes("In-memory")) ?? "";
		const command = (/`+ ?(.*?) ?`+ \|$/.exec(row)?.[1] ?? "").replaceAll("\\|", "|");
		expect(command).toBe("/livespec answer Q3 In-memory");
		await writerSays(h, command!);
		await h.call("spec_next");
		expect((await ofKind(h, "question"))[0]?.data).toMatchObject({ answer: "In-memory", adapter: "forge" });
	});
});
