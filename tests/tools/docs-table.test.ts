import { afterEach, describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { sectionText } from "../../src/core/sections.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { asChild } from "../hooks/fake-pi.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import { cleanupDirs, type ToolHarness, textOf, toolHarness } from "./helpers.ts";

afterEach(async () => {
	setSession(undefined);
	await cleanupDirs();
});

const BODY = (caps: string) =>
	["Depends: —", `Capabilities: ${caps}`, "Product impact: —", "", "## Proposal", "Limit.", "", "## Design", "Counter.", "", "## Questions", "", "## Units", "", "## Durable docs", ""].join("\n");

async function shipHarness(caps = "new [], modified []", phase = "ship"): Promise<ToolHarness> {
	const h = await toolHarness({ change: { body: BODY(caps), phase } });
	await writeIn(h.root, "specs/rate-limit/spec.md", "s\n");
	commitAll(h.root, "spec");
	await h.session.refresh();
	return h;
}

const table = async (h: ToolHarness) => sectionText(await h.world.bodyOf(h.n), "Durable docs");

describe("docs_table", () => {
	test("writes updated and not needed rows", async () => {
		const h = await shipHarness();
		const out = await h.call("docs_table", { rows: [{ file: "specs/rate-limit/spec.md", status: "updated" }, { file: "specs/glossary.md", status: "not needed", reason: "no new term" }] });
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(await table(h)).toContain("| specs/glossary.md | not needed — no new term |");
		expect(parseChange(await h.world.bodyOf(h.n)).durableDocs).toHaveLength(2);
	});

	test("is allowed in review", async () => {
		const h = await shipHarness("new [], modified []", "review");
		const out = await h.call("docs_table", { rows: [{ file: "specs/rate-limit/spec.md", status: "updated" }] });
		expect(out.isError, textOf(out)).toBeFalsy();
	});

	test("Updated row not in the diff", async () => {
		const h = await shipHarness();
		const before = await h.world.bodyOf(h.n);
		const out = await h.call("docs_table", { rows: [{ file: "specs/other/spec.md", status: "updated" }] });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("specs/other/spec.md");
		expect(await h.world.bodyOf(h.n)).toBe(before);
	});

	test("Hard rule row", async () => {
		const h = await shipHarness("new [cache], modified []");
		const out = await h.call("docs_table", { rows: [{ file: "specs/product.md", status: "not needed", reason: "small" }] });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("new capability");
	});

	test("an empty reason refuses", async () => {
		const h = await shipHarness();
		const out = await h.call("docs_table", { rows: [{ file: "specs/glossary.md", status: "not needed", reason: "" }] });
		expect(out.isError).toBe(true);
	});

	test("another phase refuses", async () => {
		const h = await shipHarness("new [], modified []", "shape");
		const before = await h.world.bodyOf(h.n);
		const out = await h.call("docs_table", { rows: [{ file: "specs/rate-limit/spec.md", status: "updated" }] });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("review");
		expect(await h.world.bodyOf(h.n)).toBe(before);
	});

	test("a child session refuses", async () => {
		const h = await shipHarness();
		const before = await h.world.bodyOf(h.n);
		const t = h.pi.tools.get("docs_table");
		const out = (await t?.execute("c", { rows: [] }, undefined, undefined, asChild(h.ctx))) as { isError: boolean; content: { text: string }[] };
		expect(out.isError).toBe(true);
		expect(out.content[0]?.text).toContain("child session");
		expect(await h.world.bodyOf(h.n)).toBe(before);
	});
});
