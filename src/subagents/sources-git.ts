// Providers that read the repository: living specs, constraints, product, diffs and the code a verifier checks.

import { matchGlob } from "../core/glob.ts";
import { declaredCapabilities, placed, readText, safeRelative, sha256, type Cx, type Provider } from "./source-kit.ts";
import { unitText } from "./sources-change.ts";
import { receiptText } from "./sources-records.ts";
import type { Placed } from "./source-types.ts";

const PRODUCT_EXCERPT_CHARS = 4000;

const fileSource = (path: string, text: string, title: string, pin = false): Placed =>
	placed({ id: `file:${path}`, version: sha256(text), title, text, untrusted: false }, pin ? "pinned" : "inline");

/** `file:specs/constraints.md`. */
export const constraints: Provider = {
	name: "constraints",
	async run({ ctx }) {
		const text = await readText(ctx.root, "specs/constraints.md");
		return text === undefined ? [] : [fileSource("specs/constraints.md", text, "Constraints")];
	},
};

/** The head of `specs/product.md`: the excerpt every packet carries. */
export const productExcerpt: Provider = {
	name: "product",
	async run({ ctx }) {
		const text = await readText(ctx.root, "specs/product.md");
		return text === undefined ? [] : [fileSource("specs/product.md", text.slice(0, PRODUCT_EXCERPT_CHARS), "Product (excerpt)")];
	},
};

/** `spec:<capability>` for every capability the change declares: the related living specs. */
export const declaredSpecs: Provider = {
	name: "capability-specs",
	async run({ ctx }) {
		const out: Placed[] = [];
		for (const cap of declaredCapabilities(ctx.state.change)) {
			const text = await readText(ctx.root, `specs/${cap}/spec.md`);
			if (text !== undefined) out.push(placed({ id: `spec:${cap}`, version: sha256(text), title: `Spec ${cap}`, text, untrusted: false }));
		}
		return out;
	},
};

async function diffSource(cx: Cx, from: string | undefined, path: string, title: string, missing: string): Promise<Placed[]> {
	if (from === undefined) throw new Error(`${missing}, so the diff source (diff:<from>..<to>) cannot be built`);
	const to = cx.ctx.state.git.head;
	const text = await cx.ctx.git.diff(from, to, path);
	return [placed({ id: `diff:${from}..${to}`, version: sha256(text), title, text, untrusted: true }, "file")];
}

/** The specs diff of the change against its `Base`, as a file. */
export const specsDiff: Provider = { name: "specs-diff", run: (cx) => diffSource(cx, cx.ctx.state.change.header.base, "specs/", "Specs diff against Base", "the change has no Base SHA") };

/** The diff since the unit's `unit-start` SHA (whole change from `Base` for a change review), as a file. */
export const codeDiff: Provider = {
	name: "diff",
	run(cx) {
		const unit = cx.target.unit?.id;
		const from = unit === undefined ? cx.ctx.state.change.header.base : cx.ctx.state.evidence.started[unit]?.pre.sha;
		const missing = unit === undefined ? "the change has no Base SHA" : `unit ${unit} has no unit-start SHA`;
		return diffSource(cx, from, ".", unit === undefined ? "Change diff against Base" : `Diff of ${unit} since its start`, missing);
	},
};

/** The finding under verification and the code at its location. */
export const findingAndCode: Provider = {
	name: "finding",
	async run({ ctx }) {
		const f = ctx.finding;
		if (!f) throw new Error("a verifier packet needs the finding to verify, and none was given");
		const text = `${f.severity} ${f.kind} at ${f.location}\nEvidence: ${f.evidence}\nFix: ${f.fix}`;
		const out = [placed({ id: `comment:finding-${sha256(text).slice(0, 12)}`, version: sha256(text), title: "Finding to verify", text, untrusted: true }, "pinned")];
		const path = f.location.split(":")[0] ?? "";
		const code = safeRelative(path) ? await readText(ctx.root, path) : undefined;
		if (code !== undefined) out.push(fileSource(path, code, `Code at ${path}`));
		return out;
	},
};

/** The unit whose `Files` own the finding's path, and that unit's receipts. */
export const owningUnit: Provider = {
	name: "owning-unit",
	async run(cx) {
		const path = cx.ctx.finding?.location.split(":")[0];
		const owner = cx.ctx.state.change.units.find((u) => path !== undefined && u.files.some((f) => f === path || matchGlob(f, path)));
		if (!owner) throw new Error(`no unit owns the finding's file ${path ?? "(no finding)"} (receipt:<unit>)`);
		const receipts = cx.ctx.state.evidence.receipts[owner.id] ?? [];
		const text = [unitText(cx, owner), ...receipts.map((r) => receiptText(owner.id, r))].join("\n\n");
		return [placed({ id: `receipt:${owner.id}`, version: sha256(text), title: `Owning unit ${owner.id}`, text, untrusted: true })];
	},
};
