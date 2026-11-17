// The `progress` rule: retry or stop after a failed post run, plus its decision record and the
// previous signature lookup the next attempt feeds back into the rule.

import { Buffer } from "node:buffer";
import { isMap } from "yaml";
import type { DecisionRecord } from "../decide/records.ts";
import type { RuleResult, RuleSchema } from "../decide/registry.ts";
import { checkAllowedKeys } from "../decide/rules/schema-util.ts";
import type { Decided } from "../decide/seam.ts";
import type { MarkedComment } from "../forge/markers.ts";
import type { Signature } from "./signature.ts";

export const PROGRESS_OUTPUT_BYTES = 2048;

const POINT = "progress";

export type ProgressFacts = { attempt: number; cap: number; signature: Signature; previous?: Signature };
export type ProgressOutcome = "retry" | "stop";

export const progressSchema: RuleSchema = {
	validate(node, report) {
		if (isMap(node)) checkAllowedKeys(node, ["mode"], "decisions.progress", report);
	},
};

const sameSignature = (a: Signature, b: Signature): boolean =>
	a.hash === b.hash && a.tests.length === b.tests.length && a.tests.every((t, i) => t === b.tests[i]);

const describeTests = (s: Signature): string => (s.tests.length === 0 ? "no test names" : `tests [${s.tests.join(", ")}]`);

/** `stop` on a failure equal to the previous one or on reaching the cap; `retry` otherwise. Never asks. */
export function progressRule(facts: unknown, _config: unknown): RuleResult {
	const f = facts as ProgressFacts;
	const where = `attempt ${f.attempt} of ${f.cap}, ${describeTests(f.signature)}, hash ${f.signature.hash}`;
	if (f.previous !== undefined && sameSignature(f.previous, f.signature)) {
		return { outcome: "stop", reason: `same failure as the previous attempt (${where})` };
	}
	if (f.attempt >= f.cap) return { outcome: "stop", reason: `attempt ${f.attempt} reached the cap ${f.cap} (${where})` };
	return { outcome: "retry", reason: `new failure (${where})` };
}

const isUtf8Continuation = (byte: number): boolean => (byte & 0xc0) === 0x80;

/** The last `maxBytes` bytes of `text` or fewer, cut on a UTF-8 character boundary. */
function utf8Tail(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return text;
	let start = bytes.length - maxBytes;
	while (start < bytes.length && isUtf8Continuation(bytes[start] as number)) start++;
	return bytes.subarray(start).toString("utf8");
}

export type ProgressInput = {
	unit: string;
	digest: string;
	start: string;
	attempt: number;
	exit: number | null;
	postSha: string;
	signature: Signature;
	outputTail: string;
	decided: Decided;
};

/** The `progress.<unit>` record of one failed attempt; `signature` and `attempt` survive `facts_hash`. */
export function progressRecord(i: ProgressInput): DecisionRecord {
	const facts = {
		start: i.start,
		attempt: i.attempt,
		exit: i.exit,
		post_sha: i.postSha,
		signature: i.signature,
		output_tail: utf8Tail(i.outputTail, PROGRESS_OUTPUT_BYTES),
	};
	return {
		point: POINT,
		subject: i.unit,
		digest: i.digest,
		source: "rule",
		outcome: i.decided.outcome as ProgressOutcome,
		reason: i.decided.reason,
		attempt: i.attempt,
		signature: i.signature,
		facts,
	};
}

const isSignature = (v: unknown): v is Signature => {
	if (typeof v !== "object" || v === null) return false;
	const { tests, hash } = v as { tests?: unknown; hash?: unknown };
	return typeof hash === "string" && Array.isArray(tests) && tests.every((t) => typeof t === "string");
};

/** The signature of the latest own `progress.<unit>` record after comment index `sinceIndex`. */
export function previousSignature(marked: MarkedComment[], unit: string, sinceIndex: number): Signature | undefined {
	const id = `${POINT}.${unit}`;
	for (let index = marked.length - 1; index > sinceIndex; index--) {
		const m = marked[index] as MarkedComment;
		if (m.kind !== "decision" || m.id !== id) continue;
		const signature = (m.data as { signature?: unknown } | null)?.signature;
		if (isSignature(signature)) return { tests: [...signature.tests], hash: signature.hash };
	}
	return undefined;
}
