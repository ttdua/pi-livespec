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
			"sed -e s/human/self/ -i.e .pi/livespec/flow.yaml": ".pi/livespec/flow.yaml",
			"perl -e s/human/self/ -i.e .pi/livespec/flow.yaml": ".pi/livespec/flow.yaml",
			"sed -i.bak -e s/a/b/ .pi/livespec/flow.yaml": ".pi/livespec/flow.yaml",
			"mv -t .pi/livespec other": ".pi/livespec",
			"mv -t.pi/livespec other": ".pi/livespec",
			"mv --target-directory=.pi/livespec other": ".pi/livespec",
			"cp -t .pi/livespec x": ".pi/livespec",
			"cp --target-directory=.pi/livespec x": ".pi/livespec",
			"ln -t .pi/livespec x": ".pi/livespec",
			"ln -t.pi/livespec x": ".pi/livespec",
			"ln --target-directory=.pi/livespec x": ".pi/livespec",
			"install -t .pi/livespec x": ".pi/livespec",
			"install -t.pi/livespec x": ".pi/livespec",
			"install --target-directory=.pi/livespec x": ".pi/livespec",
			"mv a b": undefined,
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

describe("protectedWrite option modelling", () => {
	const cases: Record<string, string | undefined> = {
		"cp --target-dir=.pi/livespec other": ".pi/livespec",
		"mv --target-dir=.pi/livespec other": ".pi/livespec",
		"ln --target-dir=.pi/livespec other": ".pi/livespec",
		"install --target-dir=.pi/livespec other": ".pi/livespec",
		"cp --target=.pi/livespec other": ".pi/livespec",
		"cp --target-dir .pi/livespec other": ".pi/livespec",
		"install -d .pi/livespec/new /tmp/other": ".pi/livespec/new",
		"install --directory .pi/livespec/new /tmp/other": ".pi/livespec/new",
		"install --dir .pi/livespec/new /tmp/other": ".pi/livespec/new",
		"env -C .pi rm livespec/flow.yaml": "livespec/flow.yaml",
		"env --chdir=.pi tee livespec/flow.yaml": "livespec/flow.yaml",
		"env --chdir .pi touch livespec/x": "livespec/x",
		"sudo -D .pi rm livespec/flow.yaml": "livespec/flow.yaml",
		"sudo --chdir=.pi rm livespec/flow.yaml": "livespec/flow.yaml",
		'env -C "$D" rm livespec/flow.yaml': "livespec/flow.yaml",
		"env -C ~/x rm livespec/flow.yaml": "livespec/flow.yaml",
		"cp --some-unknown-opt x .pi/livespec/flow.yaml": ".pi/livespec/flow.yaml",
		"sed -i --zzz s/a/b/ .pi/livespec/flow.yaml": ".pi/livespec/flow.yaml",
		"install -d /tmp/a /tmp/b": undefined,
		"env -C /tmp rm x": undefined,
		"env -C .pi cat livespec/flow.yaml": undefined,
		"cp --target-dir=/tmp other": undefined,
		"cp -a .pi/livespec /tmp/backup": undefined,
		"cp -r .pi/livespec /tmp/backup": undefined,
		"cp --preserve=mode .pi/livespec/flow.yaml /tmp/x": undefined,
		"sed -n p .pi/livespec/flow.yaml": undefined,
		"perl -ne print .pi/livespec/flow.yaml": undefined,
	};
	for (const [text, expected] of Object.entries(cases)) {
		it(text, () => expect(protectedWrite(commands(text), root)).toBe(expected));
	}

	it("a wrapper directory does not leak into the next command", () => {
		expect(protectedWrite(commands("env -C .pi true; rm livespec/x"), root)).toBeUndefined();
	});
});
