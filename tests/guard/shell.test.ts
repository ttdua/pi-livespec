import { describe, expect, it } from "vitest";
import { parseShell, type ShellCommand } from "../../src/guard/shell.ts";

function parsed(text: string): ShellCommand[] {
	const out = parseShell(text);
	if (out === "unreadable") throw new Error(`unreadable: ${text}`);
	return out;
}

const texts = (c: ShellCommand) => c.words.map((w) => w.text);

describe("parseShell", () => {
	it("parses chains, pipes, subshells and redirects", () => {
		const cmds = parsed("a && b | c; (d) > out");
		expect(cmds.map(texts)).toEqual([["a"], ["b"], ["c"], ["d"]]);
		expect(cmds[3]?.redirects.map((r) => [r.op, r.target.text])).toEqual([[">", "out"]]);
	});

	it("removes quotes and escapes from words", () => {
		const [cmd] = parsed(`echo "x" 'y' \\z`);
		expect(cmd && texts(cmd)).toEqual(["echo", "x", "y", "z"]);
		expect(cmd?.words.map((w) => w.quoted)).toEqual([false, true, true, false]);
	});

	it("keeps $(…) and backtick substitutions as raw text", () => {
		expect(parsed("echo $(git push)")[0]?.substitutions).toEqual(["git push"]);
		expect(parsed("echo `git push`")[0]?.substitutions).toEqual(["git push"]);
		expect(parsed(`echo "a $(git push) b"`)[0]?.substitutions).toEqual(["git push"]);
	});

	it("marks unquoted $ and substitutions as expansions, single quotes as literal", () => {
		const [cmd] = parsed(`git $CMD "$MSG" '$X' plain $(a)`);
		expect(cmd?.words.map((w) => w.expansion)).toEqual([false, true, true, false, false, true]);
	});

	it("separates leading assignments from words", () => {
		const [cmd] = parsed("FOO=1 GIT_DIR=x git push a=b");
		expect(cmd?.assignments).toEqual(["FOO=1", "GIT_DIR=x"]);
		expect(cmd && texts(cmd)).toEqual(["git", "push", "a=b"]);
	});

	it("splits on ||, &, newlines, groups and drops comments", () => {
		const cmds = parsed("a || b & c\n{ d; e; } # git push\nf");
		expect(cmds.map(texts)).toEqual([["a"], ["b"], ["c"], ["d"], ["e"], ["f"]]);
	});

	it("captures >>, 2> and < targets", () => {
		const [cmd] = parsed("x >> a 2> b < c 2>&1");
		expect(cmd?.redirects.map((r) => [r.op, r.target.text])).toEqual([
			[">>", "a"],
			["2>", "b"],
			["<", "c"],
			["2>&", "1"],
		]);
		expect(cmd && texts(cmd)).toEqual(["x"]);
	});

	it("unbalanced quotes are unreadable", () => {
		expect(parseShell(`echo "x`)).toBe("unreadable");
		expect(parseShell(`echo 'x`)).toBe("unreadable");
		expect(parseShell("echo $(x")).toBe("unreadable");
		expect(parseShell("(echo x")).toBe("unreadable");
		expect(parseShell("echo x)")).toBe("unreadable");
	});
});
