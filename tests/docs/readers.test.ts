// Tests of the glossary and decision packet readers.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ReviewSubject, Role } from "../../src/subagents/roles.ts";
import { registerDocReaders } from "../../src/docs/readers.ts";
import { collectSources, resetPacketSourcesForTests } from "../../src/subagents/sources.ts";
import { resolveTarget } from "../../src/subagents/target.ts";
import { FIXTURE_BODY } from "../helpers/change-state.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import { makeWorld, type World } from "./../subagents/packet-world.ts";

beforeEach(registerDocReaders);
afterEach(resetPacketSourcesForTests);

const GLOSSARY = "# Glossary\n\n- **Token bucket**: refill-based limiter\n- **Receipt**: proof of work\n- **Token**: a credential\n";
const withMention = (term: string): string => FIXTURE_BODY.replace("Rate limit per IP", `Rate limit per IP using a ${term}`);

async function sources(world: World, role: Role = "implementer", unit?: string, subject?: ReviewSubject) {
	const target = resolveTarget(world.ctx.state, role, unit, subject);
	if (!target.ok) throw new Error(target.message);
	return collectSources(world.refreshed(), target.target);
}
const find = (placed: { source: { id: string; text: string } }[], id: string) => placed.find((p) => p.source.id === id)?.source;

describe("glossary reader", () => {
	test("includes only the entries the unit mentions", async () => {
		const world = await makeWorld({ body: withMention("token bucket") });
		await writeIn(world.root, "specs/glossary.md", GLOSSARY);
		const got = find(await sources(world, "implementer", "U3"), "file:specs/glossary.md");
		expect(got?.text).toContain("**Token bucket**");
		expect(got?.text).not.toContain("Receipt");
	});

	test("no matching term yields no glossary source", async () => {
		const world = await makeWorld();
		await writeIn(world.root, "specs/glossary.md", GLOSSARY);
		expect(find(await sources(world, "implementer", "U3"), "file:specs/glossary.md")).toBeUndefined();
	});

	test("hyphenated term not matched inside another word", async () => {
		const world = await makeWorld({ body: withMention("Token-bucket") });
		await writeIn(world.root, "specs/glossary.md", GLOSSARY);
		const text = find(await sources(world, "implementer", "U3"), "file:specs/glossary.md")?.text;
		expect(text ?? "").not.toContain("**Token**");
	});
});

describe("decision reader", () => {
	test("spine and capability decisions, accepted only", async () => {
		const world = await makeWorld();
		const d = (n: string, fm: string) => writeIn(world.root, `specs/decisions/${n}.md`, `---\n${fm}\n---\n# ${n}\n`);
		await d("0001-a", "status: accepted\nspine: true");
		await d("0002-b", "status: accepted\ncapabilities: [other]");
		await d("0003-c", "status: accepted\ncapabilities: [rate-limit]");
		await d("0004-d", "status: superseded\nspine: true");
		commitAll(world.root, "decisions");
		const ids = (await sources(world, "implementer", "U3")).map((p) => p.source.id);
		expect(ids).toContain("file:specs/decisions/0001-a.md");
		expect(ids).toContain("file:specs/decisions/0003-c.md");
		expect(ids).not.toContain("file:specs/decisions/0002-b.md");
		expect(ids).not.toContain("file:specs/decisions/0004-d.md");
	});
});

describe("readers in reviewer packets", () => {
	const glossary = async (world: World) => writeIn(world.root, "specs/glossary.md", GLOSSARY);

	test("a unit reviewer gets only the entries of its own unit", async () => {
		const world = await makeWorld({ body: withMention("token bucket") });
		await glossary(world);
		const text = find(await sources(world, "reviewer", "U3", "unit"), "file:specs/glossary.md")?.text;
		expect(text).toContain("Token bucket");
		expect(text).not.toContain("Receipt");
	});

	test("a change reviewer gets the entries of every unit", async () => {
		const world = await makeWorld({ body: withMention("token bucket").replace("Request context", "Request context for a receipt") });
		await glossary(world);
		const text = find(await sources(world, "reviewer", undefined, "change"), "file:specs/glossary.md")?.text;
		expect(text).toContain("Token bucket");
		expect(text).toContain("Receipt");
	});

	test("reviewer packets carry spine and capability decisions", async () => {
		const world = await makeWorld();
		await writeIn(world.root, "specs/decisions/0001-a.md", "---\nstatus: accepted\nspine: true\n---\n# a\n");
		await writeIn(world.root, "specs/decisions/0002-b.md", "---\nstatus: superseded\nspine: true\n---\n# b\n");
		for (const [unit, subject] of [["U3", "unit"], [undefined, "change"]] as const) {
			const ids = (await sources(world, "reviewer", unit, subject)).map((p) => p.source.id);
			expect(ids).toContain("file:specs/decisions/0001-a.md");
			expect(ids).not.toContain("file:specs/decisions/0002-b.md");
		}
	});
});
