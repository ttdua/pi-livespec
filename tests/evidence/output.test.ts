import { describe, expect, test } from "vitest";
import { outputTail, StreamRedactor } from "../../src/evidence/output.ts";

const MAX = 8192;
const MARK = "…[truncated ";

/** Feeds `chunks` through one redactor and returns all redacted bytes. */
function redactAll(tokens: string[], chunks: Buffer[]): Buffer {
	const r = new StreamRedactor(tokens);
	return Buffer.concat([...chunks.map((c) => r.push(c)), r.end()]);
}

describe("StreamRedactor", () => {
	test("token split across chunks is redacted", () => {
		const r = new StreamRedactor(["s3cr3t"]);
		const first = r.push(Buffer.from("xx s3")).toString();
		const second = r.push(Buffer.from("cr3t yy")).toString();
		const rest = r.end().toString();
		const all = first + second + rest;
		for (const piece of [first, second, rest]) {
			expect(piece).not.toContain("s3cr3t");
			expect(piece).not.toContain("cr3t");
		}
		expect(first).not.toContain("s3");
		expect(all).toBe("xx *** yy");
	});

	test("token at the tail boundary is redacted", () => {
		const token = "TOKENSECRETXYZ";
		const total = 20 * 1024;
		const start = total - MAX - 3;
		const raw = Buffer.from("a".repeat(start) + token + "b".repeat(total - start - token.length));
		const chunks = [raw.subarray(0, start + 5), raw.subarray(start + 5)];
		const redacted = redactAll([token], chunks);
		const tail = outputTail(redacted.subarray(-MAX), redacted.length, MAX);
		for (let i = 0; i + 3 <= token.length; i++) expect(tail).not.toContain(token.slice(i, i + 3));
		expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(MAX);
	});

	test("empty and duplicate tokens still redact across a chunk split", () => {
		const r = new StreamRedactor(["", "s3cr3t", "s3cr3t"]);
		const first = r.push(Buffer.from("xx s3")).toString();
		const second = r.push(Buffer.from("cr3t yy")).toString();
		const all = first + second + r.end().toString();
		expect(all).toBe("xx *** yy");
	});

	test("no tokens passes bytes through", () => {
		expect(redactAll([], [Buffer.from("abc"), Buffer.from("def")]).toString()).toBe("abcdef");
	});
});

describe("outputTail", () => {
	test("whole result stays within a budget at or below the mark size", () => {
		const buf = Buffer.from("x".repeat(100));
		for (const max of [0, 1, 5, 16, 25]) {
			expect(Buffer.byteLength(outputTail(buf, 100, max))).toBeLessThanOrEqual(max);
		}
		const multi = Buffer.from("é".repeat(50));
		expect(Buffer.byteLength(outputTail(multi, 100, 16))).toBeLessThanOrEqual(16);
		expect(outputTail(multi, 100, 16)).not.toContain("\uFFFD");
	});

	test("Output tail", () => {
		const buf = Buffer.from("x".repeat(20480));
		const tail = outputTail(buf, 20480, MAX);
		expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(MAX);
		expect(tail.startsWith(MARK)).toBe(true);
		expect(tail).toMatch(/^…\[truncated \d+ bytes\]\nx+$/);
	});

	test("output tail handles binary, CRLF, multibyte cut and empty output", () => {
		expect(outputTail(Buffer.alloc(0), 0, MAX)).toBe("");

		const binary = outputTail(Buffer.from([0x61, 0xff, 0xfe, 0x62]), 4, MAX);
		expect(binary).toBe("a\uFFFD\uFFFDb");

		expect(outputTail(Buffer.from("one\r\ntwo\r\n"), 10, MAX)).toBe("one\r\ntwo\r\n");

		// The cut lands inside `é` (2 bytes) for every mark length near the budget.
		for (let pad = 0; pad < 40; pad++) {
			const buf = Buffer.from("a".repeat(MAX + pad) + "é" + "z".repeat(MAX - 40));
			const tail = outputTail(buf, buf.length, MAX);
			expect(tail).not.toContain("\uFFFD");
			expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(MAX);
		}

		const allBinary = outputTail(Buffer.alloc(MAX, 0xff), 3 * MAX, MAX);
		expect(Buffer.byteLength(allBinary)).toBeLessThanOrEqual(MAX);
		expect(allBinary.startsWith(MARK)).toBe(true);
	});

	test("the mark counts the dropped bytes", () => {
		const tail = outputTail(Buffer.from("x".repeat(MAX)), 20480, MAX);
		const dropped = Number(/^…\[truncated (\d+) bytes\]\n/.exec(tail)?.[1]);
		expect(dropped + (Buffer.byteLength(tail) - Buffer.byteLength(tail.slice(0, tail.indexOf("\n") + 1)))).toBe(20480);
	});
});
