import { describe, expect, test } from "vitest";
import { parseCommand } from "../../src/interaction/commands.ts";

describe("parseCommand", () => {
	test("approve without notes", () => {
		expect(parseCommand("/livespec approve")).toEqual({ verb: "approve", notes: "" });
	});

	test("approve with notes", () => {
		expect(parseCommand("/livespec approve looks good")).toEqual({ verb: "approve", notes: "looks good" });
	});

	test("changes with notes", () => {
		expect(parseCommand("/livespec changes split U3 in two")).toEqual({ verb: "changes", notes: "split U3 in two" });
	});

	test("changes without notes is an error", () => {
		expect(parseCommand("/livespec changes")).toHaveProperty("error");
	});

	test("dismiss with and without notes", () => {
		expect(parseCommand("/livespec dismiss")).toEqual({ verb: "dismiss", notes: "" });
		expect(parseCommand("/livespec dismiss not now")).toEqual({ verb: "dismiss", notes: "not now" });
	});

	test("choose with an option and notes", () => {
		expect(parseCommand("/livespec choose waive flaky check")).toEqual({
			verb: "choose",
			option: "waive",
			notes: "flaky check",
		});
	});

	test("choose without an id is an error", () => {
		expect(parseCommand("/livespec choose")).toHaveProperty("error");
	});

	test("--changes is refused with the removal message", () => {
		expect(parseCommand("/livespec answer Q2 use per-user limits --changes rate-limit/Requirement: Per-IP cap")).toEqual({ error: "--changes was removed: edit the spec instead; livespec cascades requirement edits from the spec diff" });
	});

	test("answer text with a --changes token is refused", () => {
		expect(parseCommand("/livespec answer Q2 keep --changes off")).toEqual({ error: "--changes was removed: edit the spec instead; livespec cascades requirement edits from the spec diff" });
	});

	test("answer without flags", () => {
		expect(parseCommand("/livespec answer Q1 yes")).toEqual({ verb: "answer", question: "Q1", text: "yes" });
	});

	test("answer with --class is an error", () => {
		const out = parseCommand("/livespec answer Q2 per-user --class blocking");
		expect(out).toHaveProperty("error");
		expect((out as { error: string }).error).toContain("--class");
		expect(parseCommand("/livespec answer Q3 keep it --class maybe")).toHaveProperty("error");
	});

	test("answer without text is an error", () => {
		expect(parseCommand("/livespec answer Q3")).toHaveProperty("error");
		expect(parseCommand("/livespec answer Q3 --changes a/Requirement: B")).toHaveProperty("error");
	});

	test("answer with a bad question id is an error", () => {
		expect(parseCommand("/livespec answer U3 yes")).toHaveProperty("error");
	});

	test("class is an unknown command", () => {
		expect(parseCommand("/livespec class Q2 non-blocking")).toEqual({ error: 'unknown command "class"' });
	});

	test("set difficulty", () => {
		expect(parseCommand("/livespec set U2 difficulty high")).toEqual({
			verb: "set",
			unit: "U2",
			field: "difficulty",
			value: "high",
		});
		expect(parseCommand("/livespec set U2 difficulty extreme")).toHaveProperty("error");
	});

	test("set tags splits on commas", () => {
		expect(parseCommand("/livespec set U2 tags a, b")).toEqual({
			verb: "set",
			unit: "U2",
			field: "tags",
			value: ["a", "b"],
		});
	});

	test("set with an unknown field is an error", () => {
		expect(parseCommand("/livespec set U2 owner me")).toHaveProperty("error");
	});

	test("unknown verb is an error", () => {
		expect(parseCommand("/livespec merge")).toHaveProperty("error");
	});

	test("CRLF first line is accepted", () => {
		expect(parseCommand("/livespec approve ship it\r\nmore text\r\n")).toEqual({
			verb: "approve",
			notes: "ship it",
		});
	});

	test("extra spaces between tokens are tolerated", () => {
		expect(parseCommand("/livespec  approve   ok")).toEqual({ verb: "approve", notes: "ok" });
	});

	test("quoted, indented or later-line commands are ignored", () => {
		expect(parseCommand("> /livespec approve")).toBeUndefined();
		expect(parseCommand("  /livespec approve")).toBeUndefined();
		expect(parseCommand("\n/livespec approve")).toBeUndefined();
		expect(parseCommand("thanks\n\n/livespec approve")).toBeUndefined();
		expect(parseCommand("please /livespec approve")).toBeUndefined();
		expect(parseCommand("/livespecapprove")).toBeUndefined();
		expect(parseCommand("")).toBeUndefined();
	});
});
