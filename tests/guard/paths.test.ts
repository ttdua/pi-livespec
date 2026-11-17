import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isLivespecPath, protectedWrite } from "../../src/guard/paths.ts";
import { parseShell, type ShellCommand } from "../../src/guard/shell.ts";

let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "livespec-paths-"));
	mkdirSync(join(root, ".pi", "livespec"), { recursive: true });
	mkdirSync(join(root, "src"));
	symlinkSync(join(".pi", "livespec"), join(root, "link"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function commands(text: string): ShellCommand[] {
	const out = parseShell(text);
	if (out === "unreadable") throw new Error(`unreadable: ${text}`);
	return out;
}

describe("isLivespecPath", () => {
	it("is true for paths under .pi/livespec, however they are spelled", () => {
		for (const p of [".pi/livespec/flow.yaml", "./.pi/livespec/x", "src/../.pi/livespec/config.yaml", join(root, ".pi/livespec/new/deep.yaml"), "link/flow.yaml"]) {
			expect(isLivespecPath(root, p), p).toBe(true);
		}
	});

	it("is false for look-alike paths", () => {
		for (const p of [".pi/livespecx/a", "docs/.pi/livespec/a", ".pi/other", "src/a.ts"]) {
			expect(isLivespecPath(root, p), p).toBe(false);
		}
	});

	it("Path traversal", () => {
		expect(isLivespecPath(root, "src/../.pi/livespec/config.yaml")).toBe(true);
	});
});

describe("protectedWrite", () => {
	it("Directory change before the write", () => {
		expect(protectedWrite(commands("cd .pi; echo x > livespec/flow.yaml"), root)).toBe("livespec/flow.yaml");
		expect(protectedWrite(commands("(cd sub); echo x > .pi/livespec/flow.yaml"), root)).toBe(".pi/livespec/flow.yaml");
		expect(protectedWrite(commands(`cd "$D" && echo x > livespec/flow.yaml`), root)).toBe("livespec/flow.yaml");
		expect(protectedWrite(commands("cd src && echo x > out.txt"), root)).toBeUndefined();
	});

	it("finds targets of write commands and ignores reads", () => {
		const hits: Record<string, string | undefined> = {
			"tee -a .pi/livespec/flow.yaml": ".pi/livespec/flow.yaml",
			"cp a b .pi/livespec/": ".pi/livespec/",
			"cp -t .pi/livespec a": ".pi/livespec",
			"mv .pi/livespec/flow.yaml /tmp/x": ".pi/livespec/flow.yaml",
			"ln -s x link/flow.yaml": "link/flow.yaml",
			"touch .pi/livespec/x": ".pi/livespec/x",
			"install -m 644 a .pi/livespec/b": ".pi/livespec/b",
			"sed -i -e s/a/b/ .pi/livespec/flow.yaml": ".pi/livespec/flow.yaml",
			"perl -pi -e s/a/b/ .pi/livespec/flow.yaml": ".pi/livespec/flow.yaml",
			"cat .pi/livespec/flow.yaml": undefined,
			"cp .pi/livespec/flow.yaml /tmp/x": undefined,
			"sed -n p .pi/livespec/flow.yaml": undefined,
			"wc -l < .pi/livespec/flow.yaml": undefined,
			"echo x 2>&1 > out.txt": undefined,
			"rm -rf .pi": ".pi",
			"mv .pi /tmp/x": ".pi",
			"mv -t /tmp .pi": ".pi",
			"mv -t/tmp .pi": ".pi",
			"mv -t/tmp other": undefined,
			"cp -- -tfoo .pi/livespec/flow.yaml": ".pi/livespec/flow.yaml",
			"ln -- -tfoo .pi/livespec/flow.yaml": ".pi/livespec/flow.yaml",
			"install -- -tfoo .pi/livespec/flow.yaml": ".pi/livespec/flow.yaml",
			"rmdir .pi/livespec": ".pi/livespec",
			"rm -rf .pi/other": undefined,
			"mv src .": undefined,
			"sed -i -es/human/self/ .pi/livespec/flow.yaml": ".pi/livespec/flow.yaml",
			"sed -i.bak -es/a/b/ .pi/livespec/flow.yaml": ".pi/livespec/flow.yaml",
			"sed -i -f/tmp/x.sed .pi/livespec/flow.yaml": ".pi/livespec/flow.yaml",
			"sed -i -e s/a/b/ -e s/c/d/ .pi/livespec/flow.yaml": ".pi/livespec/flow.yaml",
			"sed --in-place=.bak --expression=s/a/b/ .pi/livespec/flow.yaml": ".pi/livespec/flow.yaml",
			"sed -i s/a/b/ .pi/livespec/flow.yaml": ".pi/livespec/flow.yaml",
			"perl -i -pes/a/b/ .pi/livespec/flow.yaml": ".pi/livespec/flow.yaml",
			"perl -i.bak -e s/a/b/ .pi/livespec/flow.yaml": ".pi/livespec/flow.yaml",
			"install -m644 src .pi/livespec/flow.yaml": ".pi/livespec/flow.yaml",
			"cp -t.pi/livespec x": ".pi/livespec",
			"sed -i -es/a/b/ other.txt": undefined,
			"sed -i s/livespec/x/ other.txt": undefined,
			"perl -ne print .pi/livespec/flow.yaml": undefined,
			"mv /tmp/x .pi": undefined,
		};
		for (const [text, expected] of Object.entries(hits)) {
			expect(protectedWrite(commands(text), root), text).toBe(expected);
		}
	});
});
