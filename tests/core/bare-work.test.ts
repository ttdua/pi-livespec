import { describe, expect, it } from "vitest";
import { parseBareWork, serializeBareWork } from "../../src/core/bare-work.ts";

describe("bare-work.test", () => {
	it("line parsed", () => {
		const text = "2026-01-02 — src/a.ts, src/b.ts — fix typo — in docs\n\n";
		const b = parseBareWork(text);
		expect(b.entries).toEqual([
			{ date: "2026-01-02", files: ["src/a.ts", "src/b.ts"], summary: "fix typo — in docs", line: 1 },
		]);
		expect(serializeBareWork(b)).toBe(text);
	});

	it("blank and malformed lines pass through", () => {
		const text = "# Log\r\n\r\nnot an entry\r\n2026-01-02 — a.ts — s";
		const b = parseBareWork(text);
		expect(b.entries).toHaveLength(1);
		expect(serializeBareWork(b)).toBe(text);
	});
});
