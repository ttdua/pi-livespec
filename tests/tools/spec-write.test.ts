import { afterEach, describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { splitLines } from "../../src/core/lines.ts";
import { sectionText } from "../../src/core/sections.ts";
import type { Forge } from "../../src/forge/types.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import type { MemoryWorld } from "../forge/memory-forge.ts";
import { CHANGE_BRANCH, cardText, resumeBody } from "../hooks/helpers.ts";
import { planWrite, postconditionFailure, type PlannedWrite } from "../../src/tools/spec-write-rules.ts";
import { cleanupDirs, textOf, toolHarness } from "./helpers.ts";

afterEach(async () => {
	setSession(undefined);
	await cleanupDirs();
});

const DEFINE_LABELS = ["livespec", "livespec:phase/define"];
const PROPOSAL = "Cap each client IP at 100 requests per minute.";

type BodyOf = (head: string) => string;

async function defineChange(body: BodyOf = resumeBody, forge?: (world: MemoryWorld) => Forge) {
	const h = await toolHarness({ branch: CHANGE_BRANCH, ...(forge ? { forge } : {}) });
	const before = body(h.head);
	const n = await h.world.seedIssue({ title: "per-ip-cap", body: before, labels: DEFINE_LABELS });
	return { ...h, n, before };
}

const texts = (body: string) => splitLines(body).map((l) => l.text + l.eol);

/** Lines before `## <from>` and from `## <until>` on. */
function outside(body: string, from: string, until: string): { head: string[]; tail: string[] } {
	const lines = texts(body);
	const start = lines.findIndex((l) => l.replace(/\r?\n$/, "") === `## ${from}`);
	const end = lines.findIndex((l) => l.replace(/\r?\n$/, "") === `## ${until}`);
	return { head: lines.slice(0, start), tail: lines.slice(end) };
}

describe("spec_write", () => {
	test("Write proposal", async () => {
		const h = await defineChange();
		const out = await h.call("spec_write", { section: "Proposal", content: `${PROPOSAL}\n` });
		expect(out.isError).toBe(false);
		const after = await h.world.bodyOf(h.n);
		expect(sectionText(after, "Proposal")).toBe(PROPOSAL);
		expect(outside(after, "Proposal", "Design")).toEqual(outside(h.before, "Proposal", "Design"));
	});

	test("Create missing section", async () => {
		const h = await defineChange((head) => resumeBody(head).replace("## Design\nSliding window counter in memory.\n\n", ""));
		const out = await h.call("spec_write", { section: "Design", content: "Fixed window per IP in a map." });
		expect(out.isError).toBe(false);
		const after = await h.world.bodyOf(h.n);
		const headings = splitLines(after).filter((l) => l.text.startsWith("## ")).map((l) => l.text);
		expect(headings).toEqual(["## Proposal", "## Design", "## Questions", "## Units", "## Durable docs"]);
		expect(sectionText(after, "Design")).toBe("Fixed window per IP in a map.");
		const lines = texts(after);
		const designAt = lines.indexOf("## Design\n");
		const questionsAt = lines.indexOf("## Questions\n");
		const old = texts(h.before);
		const oldQuestionsAt = old.indexOf("## Questions\n");
		expect(lines.slice(0, designAt)).toEqual(old.slice(0, oldQuestionsAt));
		expect(lines.slice(questionsAt)).toEqual(old.slice(oldQuestionsAt));
	});

	test("unterminated final line gains one EOL when a section is appended", async () => {
		const h = await defineChange(() => "Capabilities: new [], modified []\nProduct impact: —");
		const out = await h.call("spec_write", { section: "Proposal", content: PROPOSAL });
		expect(out.isError).toBe(false);
		expect(await h.world.bodyOf(h.n)).toBe(`Capabilities: new [], modified []\nProduct impact: —\n\n## Proposal\n${PROPOSAL}\n`);
	});

	test("Conflict", async () => {
		let world!: MemoryWorld;
		let n = 0;
		const racing = (w: MemoryWorld): Forge => {
			world = w;
			return new Proxy(w.forge, {
				get(target, prop, receiver) {
					const value = Reflect.get(target, prop, receiver);
					if (prop !== "updateIssueBody" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
					return async (...args: unknown[]) => {
						await world.editBodyBehindBack(n, `${await world.bodyOf(n)}edited elsewhere\n`);
						return value.apply(target, args);
					};
				},
			});
		};
		const h = await defineChange(resumeBody, racing);
		n = h.n;
		const out = await h.call("spec_write", { section: "Proposal", content: PROPOSAL });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("conflict");
		expect(textOf(out)).toContain("body");
		const after = await h.world.bodyOf(h.n);
		expect(after).toBe(`${h.before}edited elsewhere\n`);
	});

	test("CRLF body keeps every other line byte-identical", async () => {
		const h = await defineChange((head) => resumeBody(head).replaceAll("\n", "\r\n"));
		const out = await h.call("spec_write", { section: "Design", content: "Line one.\nLine two." });
		expect(out.isError).toBe(false);
		const after = await h.world.bodyOf(h.n);
		expect(after).toContain("## Design\r\nLine one.\r\nLine two.\r\n\r\n## Questions\r\n");
		expect(outside(after, "Design", "Questions")).toEqual(outside(h.before, "Design", "Questions"));
	});

	test("Invalid capabilities", async () => {
		const h = await defineChange();
		const out = await h.call("spec_write", { section: "Capabilities", content: "new [Rate Limit], modified []" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("Rate Limit");
		expect(await h.world.bodyOf(h.n)).toBe(h.before);
	});

	test("capability names with bad hyphens are refused", async () => {
		const h = await defineChange();
		for (const content of ["new [-bad], modified []", "new [], modified [bad--name]", "new [a], modified"]) {
			const out = await h.call("spec_write", { section: "Capabilities", content });
			expect(out.isError).toBe(true);
		}
		expect(await h.world.bodyOf(h.n)).toBe(h.before);
	});

	test("valid capabilities are written to the header line", async () => {
		const h = await defineChange();
		const out = await h.call("spec_write", { section: "Capabilities", content: "new [per-ip-cap], modified [rate-limit, request-context]" });
		expect(out.isError).toBe(false);
		const after = await h.world.bodyOf(h.n);
		expect(parseChange(after).header.capabilities).toEqual({ new: ["per-ip-cap"], modified: ["rate-limit", "request-context"] });
		expect(after).toBe(h.before.replace("Capabilities: new [], modified [rate-limit]", "Capabilities: new [per-ip-cap], modified [rate-limit, request-context]"));
	});

	test("Product impact is written to the header line", async () => {
		const h = await defineChange();
		const out = await h.call("spec_write", { section: "Product impact", content: "clients over the cap get 429" });
		expect(out.isError).toBe(false);
		expect(await h.world.bodyOf(h.n)).toBe(
			h.before.replace("Product impact: none — internal limit only", "Product impact: clients over the cap get 429"),
		);
	});

	test("Heading inside content", async () => {
		const h = await defineChange();
		const out = await h.call("spec_write", { section: "Design", content: "Intro.\n## Units\nsneaky" });
		expect(out.isError).toBe(true);
		const empty = await h.call("spec_write", { section: "Proposal", content: " \n" });
		expect(empty.isError).toBe(true);
		expect(await h.world.bodyOf(h.n)).toBe(h.before);
	});

	test("Unsupported section", async () => {
		const h = await defineChange();
		const out = await h.call("spec_write", { section: "Units", content: "### U1 — x" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("plan_units");
		const other = await h.call("spec_write", { section: "Questions", content: "x" });
		expect(other.isError).toBe(true);
		expect(await h.world.bodyOf(h.n)).toBe(h.before);
	});

	test("Read-only", async () => {
		const h = await defineChange();
		await h.session.refresh();
		await h.world.makeUnreachable();
		const out = await h.call("spec_write", { section: "Proposal", content: PROPOSAL });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("read-only");
		await h.world.restore();
		expect(await h.world.bodyOf(h.n)).toBe(h.before);
	});

	test("After a write tool", async () => {
		const h = await defineChange((head) => resumeBody(head).replace("Limit each client IP.\n", ""));
		await h.session.refresh();
		expect(await cardText(h.pi, h.ctx)).toContain("Write Proposal with spec_write.");
		const out = await h.call("spec_write", { section: "Proposal", content: PROPOSAL });
		expect(out.isError).toBe(false);
		expect(await cardText(h.pi, h.ctx)).not.toContain("Write Proposal with spec_write.");
	});
});

function planned(section: string, content: string): PlannedWrite {
	const plan = planWrite(section, content);
	if (!plan.ok) throw new Error(plan.message);
	return plan.write;
}

describe("spec_write postconditions", () => {
	const UNTERMINATED = "Product impact: —\n\n## Proposal\nOld.\n\n## Design\nD.\n\n## Durable docs\n| a | b |";

	test("another outside-line change is refused", () => {
		const before = resumeBody("f".repeat(40));
		const w = planned("Proposal", PROPOSAL);
		const good = before.replace("Limit each client IP.", PROPOSAL);
		expect(postconditionFailure(before, good, w)).toBeUndefined();
		expect(postconditionFailure(before, good.replace("Sliding window counter in memory.", "Tampered."), w)).toContain("outside");
		expect(postconditionFailure(before, good.replace("Initiative: #12\n", "Initiative: #12\r\n"), w)).toContain("outside");
		expect(postconditionFailure(before, good.replace("## Questions\n", "\n## Questions\n"), w)).toContain("outside");
	});

	test("the final line may not gain an EOL when nothing is appended after it", () => {
		const w = planned("Proposal", PROPOSAL);
		const good = UNTERMINATED.replace("Old.", PROPOSAL);
		expect(postconditionFailure(UNTERMINATED, good, w)).toBeUndefined();
		expect(postconditionFailure(UNTERMINATED, `${good}\n`, w)).toContain("outside");
		const header = planned("Product impact", "users see 429");
		const headerGood = UNTERMINATED.replace("Product impact: —", "Product impact: users see 429");
		expect(postconditionFailure(UNTERMINATED, headerGood, header)).toBeUndefined();
		expect(postconditionFailure(UNTERMINATED, `${headerGood}\n`, header)).toContain("Product impact");
	});

	test("an appended section may add only the one separator replaceSection emits", () => {
		const before = "Capabilities: new [], modified []\n\n";
		const w = planned("Proposal", PROPOSAL);
		expect(postconditionFailure(before, `${before}## Proposal\n${PROPOSAL}\n`, w)).toBeUndefined();
		expect(postconditionFailure(before, `${before}\n## Proposal\n${PROPOSAL}\n`, w)).toContain("outside");
	});
});
