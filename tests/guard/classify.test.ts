import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ProjectConfig } from "../../src/config.ts";
import { classifyCommand, forgeEndpoints, type GuardContext, type GuardDecision } from "../../src/guard/classify.ts";

const cwd = mkdtempSync(join(tmpdir(), "livespec-guard-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

const github: GuardContext = { cwd, endpoints: forgeEndpoints({ kind: "github", host: "github.com" }, null), aliases: {} };
const gitea: GuardContext = { cwd, endpoints: forgeEndpoints({ kind: "gitea", host: "git.example.com" }, null), aliases: {} };

function blocked(command: string, ctx: GuardContext = github): Extract<GuardDecision, { allow: false }> {
	const d = classifyCommand(command, ctx);
	if (d.allow) throw new Error(`expected a block: ${command}`);
	return d;
}

function expectBlocked(commands: string[], ctx: GuardContext = github): void {
	const allowed = commands.filter((c) => classifyCommand(c, ctx).allow);
	expect(allowed).toEqual([]);
}

function expectAllowed(commands: string[], ctx: GuardContext = github): void {
	const refused = commands.filter((c) => !classifyCommand(c, ctx).allow);
	expect(refused).toEqual([]);
}

describe("forgeEndpoints", () => {
	it("lists host, authority, GitHub API hosts and config hosts", () => {
		const config: ProjectConfig = { githubHosts: ["ghe.corp"], giteaUrl: "https://Gitea.Corp:3000/", agentSkillsChannelSet: false };
		expect(forgeEndpoints({ kind: "github", host: "github.com", authority: "github.com" }, config)).toEqual([
			"github.com",
			"api.github.com",
			"uploads.github.com",
			"ghe.corp",
			"gitea.corp:3000",
		]);
		expect(forgeEndpoints({ kind: "gitea", host: "git.example.com", authority: "git.example.com:3000" }, null)).toEqual([
			"git.example.com",
			"git.example.com:3000",
		]);
		expect(forgeEndpoints(undefined, null)).toEqual(["github.com", "api.github.com"]);
	});
});

describe("classifyCommand", () => {
	it("Reason names the tool", () => {
		const d = blocked("gh issue edit 6 --body-file body.md");
		expect(d.reason).toMatch(/^livespec guard: /);
		expect(d.reason).toContain("spec_write");
	});

	it("Manual tick blocked", () => {
		expect(blocked(`gh issue edit 6 --body "…- [x] done…"`).reason).toContain("spec_write");
	});

	it("Self-approval comment blocked", () => {
		expect(blocked(`gh issue comment 6 --body "/livespec approve"`).reason).toMatch(/spec_question|spec_gate/);
	});

	it("API write blocked, read allowed", () => {
		expectBlocked(["gh api -X PATCH repos/o/r/issues/6 -f body=x"]);
		expectAllowed(["gh api repos/o/r/issues/6"]);
	});

	it("Raw HTTP write to the forge host", () => {
		expectBlocked([`curl -X POST https://git.example.com/api/v1/repos/o/r/issues/6/comments -d '{}'`], gitea);
		expectAllowed(["curl -X POST https://example.org/hook"], gitea);
	});

	it("GitHub API host", () => {
		expectBlocked([`curl -X PATCH https://api.github.com/repos/o/r/issues/6 -d '{"body":"x"}'`]);
	});

	it("Tea write blocked", () => {
		expectBlocked([`tea comment 6 "/livespec approve"`], gitea);
		expectAllowed(["tea issues list"], gitea);
	});

	it("Push variants blocked", () => {
		expectBlocked([
			"git push",
			"git -C . push origin HEAD",
			"env GIT_TRACE=1 git push",
			"FOO=1 git push",
			`sh -c "cd x && git push"`,
			"bash -c 'git push --force'",
			"echo $(git push)",
			"xargs git push < /dev/null",
			"git -c user.name=x push",
		]);
	});

	it("Push alias blocked", () => {
		expectBlocked(["git p"], { ...github, aliases: { p: "push" } });
	});

	it("Pull request commands blocked", () => {
		expectBlocked(["gh pr create --fill", "gh pr merge 3", "tea pr create"]);
	});

	it("Ordinary git allowed", () => {
		expectAllowed(["git status", `git commit -m "x"`, "git log --oneline", "git -C sub fetch"]);
	});

	it("Eval blocked", () => {
		expectBlocked([`eval "git push"`]);
	});

	it("Variable git subcommand", () => {
		expectBlocked(["CMD=push; git $CMD"]);
		expectAllowed([`git commit -m "$MSG"`]);
	});

	it("Variable command word", () => {
		expectBlocked(["X=gh; $X issue comment 6 -b hi"]);
	});

	it("Harmless eval allowed", () => {
		expectAllowed([`eval "$(ssh-agent -s)"`]);
	});

	it("Script file allowed", () => {
		expectAllowed(["bash ./scripts/release.sh"]);
	});

	it("Shell write blocked", () => {
		expectBlocked([`echo "gate: self" >> .pi/livespec/flow.yaml`, "sed -i s/human/self/ ./.pi/livespec/flow.yaml"]);
	});

	it("Directory change before the write", () => {
		expectBlocked(["cd .pi; echo x > livespec/flow.yaml", "(cd sub); echo x > .pi/livespec/flow.yaml", `cd "$D" && echo x > livespec/flow.yaml`]);
		expectAllowed(["cd src && echo x > out.txt"]);
	});

	it("Read allowed", () => {
		expectAllowed(["cat .pi/livespec/flow.yaml"]);
	});

	it("push and gh variants beyond the spec list are blocked", () => {
		expectBlocked([
			"git --no-pager push",
			"GIT_DIR=x git push",
			"cd sub && git push",
			"\\git push",
			`"git" "push"`,
			"/usr/bin/git push",
			"gh --repo o/r issue edit 6",
			"cd .pi && echo x > livespec/flow.yaml",
			"git --git-dir=.git --work-tree . push",
			"git --namespace x -p --bare push",
			"sudo -u me nice -n 5 timeout -s KILL 10 nohup command git push",
			"time exec git push",
			`bash -lc "git push"`,
			"echo `git push`",
			"gh -R o/r pr merge 3",
			"gh api --method=POST repos/o/r/issues -f title=x",
			"gh api repos/o/r/issues/6/comments --input body.json",
			"gh label create x",
			"gh release create v1",
			"gh secret set X",
			"tea issues edit 6",
			"tea pulls merge 3",
			"wget --post-data=x https://api.github.com/repos/o/r/issues",
			"curl --json '{}' https://api.github.com/repos/o/r/issues",
			"eval git push",
			"echo git push | bash",
			"tee .pi/livespec/flow.yaml < x",
			"cp x .pi/livespec/flow.yaml",
			"rm -f .pi/livespec/config.yaml",
		]);
	});

	it("everyday commands mentioning push, gh or tea are allowed", () => {
		expectAllowed([
			"grep -r push src/",
			"git log --grep=push",
			`echo "gh is installed"`,
			"rg tea",
			"bun test",
			"git stash push -m x",
			"cd src && echo x > out.txt",
			"gh issue view 6",
			"gh pr list",
			"gh api -X GET repos/o/r/issues -f state=open",
			"curl https://api.github.com/repos/o/r",
			"curl -I https://api.github.com",
			"git commit -m 'push the button'",
			"bun run test 2>&1 | tail -5",
		]);
	});

	it("env -S and --split-string re-parse their value as a script", () => {
		expectBlocked([
			"env -S 'git push'",
			"env --split-string='git push'",
			"env --split-string 'git push origin'",
			"env -S'git push'",
			"env -S git push",
			"env -i -S 'gh issue edit 6'",
			"env -S 'echo x > .pi/livespec/flow.yaml'",
			'env -S "$CMD" push',
		]);
		expectAllowed(["env -S 'git status'", "env -S 'bun test'"]);
	});

	it("setsid, stdbuf, doas, ionice and flock are unwrapped", () => {
		expectBlocked([
			"setsid git push",
			"setsid -f -w git push",
			"stdbuf -oL git push",
			"stdbuf -i 0 -o L -e 0 git push",
			"stdbuf --output=L git push",
			"doas git push",
			"doas -u me git push",
			"ionice git push",
			"ionice -c 2 -n 7 git push",
			"ionice -c3 -t gh pr create",
			"flock /tmp/lock git push",
			"flock -w 5 -x /tmp/lock git push",
			"flock -c 'git push' /tmp/lock",
			"flock /tmp/lock -c 'git push'",
			"flock --command='git push' /tmp/lock",
			"flock /tmp/lock --command 'git push'",
		]);
		expectAllowed(["setsid bun test", "stdbuf -oL bun test", "doas -u me ls", "ionice -c 3 bun test", "flock /tmp/lock bun test", "flock -c 'bun test' /tmp/lock", "flock 9"]);
	});

	it("git send-pack and git subtree push are pushes", () => {
		for (const c of ["git send-pack origin main", "git subtree push --prefix=lib origin main", "git subtree push -P lib origin main", "git subtree -P lib push origin main"]) {
			expect(blocked(c).rule, c).toBe("push");
		}
		expectAllowed(["git subtree split -P lib", "git subtree pull -P lib origin main"]);
	});

	it("gh alias set and import are blocked", () => {
		for (const c of ["gh alias set co 'pr checkout'", "gh alias import aliases.yml", "gh -R o/r alias set x 'issue edit'"]) {
			const d = blocked(c);
			expect(d.rule, c).toBe("gh-alias");
			expect(d.reason).toContain("gh aliases can hide forge writes");
		}
		expectAllowed(["gh alias list", "gh alias delete co"]);
	});

	it("removing or moving an ancestor of .pi/livespec is blocked", () => {
		expectBlocked(["rm -rf .pi", "mv .pi /tmp/x", "rmdir .pi/livespec", "rm -rf ./.pi/", "cd .pi && cd .. && rm -r .pi", "rm -rf ."]);
		expectAllowed(["rm -rf .pi/other", "mv src/a.ts .", "mv a.txt .pi/other/", "rm -rf src"]);
	});

	it("an unknown alias map blocks unknown git subcommands mentioning push only", () => {
		const unknown: GuardContext = { ...github, aliases: "unknown" };
		expectBlocked(["git pp push"], unknown);
		expectAllowed(["git pp", "git stash push -m x", "git status"], unknown);
	});

	it("shell aliases containing push are blocked", () => {
		expectBlocked(["git sync"], { ...github, aliases: { sync: "!git fetch && git push" } });
		expectBlocked(["git -c alias.x='!git push' x", "git -c alias.y=push y origin"]);
	});

	it("an unreadable alias body is scanned on its own text", () => {
		expectBlocked(["git wipe"], { ...github, aliases: { wipe: "!rm .pi/livespec/config.yaml\necho ${" } });
		expectBlocked(["git hide"], { ...github, aliases: { hide: "!gh issue edit 6 -b x\necho ${" } });
		expectAllowed(["git broken"], { ...github, aliases: { broken: "!echo hello\necho ${" } });
	});

	it("unreadable input is blocked only when it mentions a dangerous token", () => {
		expect(blocked(`echo "git push`).rule).toBe("obscured");
		expectAllowed([`echo "hello`]);
	});

	it("substitutions inside parameter, arithmetic and here-document text are checked", () => {
		expectBlocked(["echo ${X:-$(git push)}", "echo $(( $(git push) + 1 ))", "cat <<EOF\n$(git push)\nEOF", "cat <<EOF\n`gh issue comment 6 -b x`\nEOF", "echo ${X:-$(git push)"]);
		expectAllowed(["cat <<'EOF'\n$(git push)\nEOF", "echo $((1 + 2))", "echo ${HOME:-/tmp}"]);
	});

	it("backslash-newline in a here-document delimiter or body is a line continuation", () => {
		expectBlocked(["cat <<EO\\\nF\n$(git push)\nEOF", "cat <<EOF\n$\\\n(git push)\nEOF"]);
	});

	it("a literal { inside ${…} does not hide later commands", () => {
		expectBlocked(["echo ${X:-{}; rm .pi/livespec/config.yaml"]);
		expectAllowed(["echo ${X:-{}; rm out.txt"]);
	});

	it("unreadable input mentioning livespec is blocked", () => {
		expectBlocked([`echo "x > .pi/livespec/flow.yaml`, "rm .pi/livespec/x ${"]);
	});

	it("wrapped writes into .pi/livespec are blocked", () => {
		expectBlocked([
			"command rm .pi/livespec/config.yaml",
			"env A=1 tee .pi/livespec/flow.yaml",
			"sudo -u me cp x .pi/livespec/flow.yaml",
			"xargs rm .pi/livespec/flow.yaml",
			"nice -n 5 sed -i s/a/b/ .pi/livespec/flow.yaml",
			"command cd .pi && echo x > livespec/flow.yaml",
		]);
		expectAllowed(["command rm out.txt", "env A=1 cat .pi/livespec/flow.yaml"]);
	});

	it("nested shells and substitutions keep the directory of earlier commands", () => {
		expectBlocked([
			"cd .pi; sh -c 'echo x > livespec/flow.yaml'",
			"cd .pi && echo $(echo x > livespec/flow.yaml)",
			"cd .pi; eval 'echo x > livespec/flow.yaml'",
		]);
		expectAllowed([`sh -c "cd .pi"; echo x > livespec/flow.yaml`, "echo $(cd .pi) > livespec/flow.yaml"]);
	});

	it("gh api rule applies to gh only", () => {
		expectAllowed(["echo api -X POST", "echo api -f x=y"]);
	});

	it("a request body to a forge endpoint blocks even with GET or HEAD", () => {
		expectBlocked(["curl -X GET -d x https://api.github.com", "wget --method=GET --body-data=x https://api.github.com", "curl -G -d q=1 https://api.github.com/search"]);
		expectAllowed(["curl -X GET -d x https://example.org"]);
	});

	it("eval with a dangerous token is blocked before reparsing", () => {
		expect(blocked("eval 'echo push'").rule).toBe("obscured");
		expectAllowed([`eval "$(ssh-agent -s)"`, "eval 'echo hello'"]);
	});

	it("every block reason names the rule that matched", () => {
		const samples = [
			"git push",
			"gh issue edit 6",
			"gh pr create",
			"tea pr create",
			"gh api -X DELETE x",
			"gh label create x",
			"tea comment 6 x",
			"curl -d x https://github.com",
			"eval git push",
			"rm .pi/livespec/x",
		];
		const rules = new Set<string>();
		for (const c of samples) {
			const d = blocked(c);
			rules.add(d.rule);
			expect(d.reason, c).toContain(`rule ${d.rule}`);
		}
		expect([...rules].sort()).toEqual(["gh-api", "gh-issue", "gh-write", "http-write", "livespec-files", "obscured", "pull-request", "push", "tea-write"]);
	});

	it("block reasons start with the guard prefix and name the rule's tool", () => {
		const push = blocked("git push");
		expect(push.reason).toMatch(/^livespec guard: /);
		expect(push.reason).toContain("livespec tools");
		expect(push.reason).toContain("LS-09");
		for (const c of ["gh pr create", "gh api -X DELETE x", "curl -d x https://github.com", "eval git push", "rm .pi/livespec/x"]) {
			expect(blocked(c).reason).toMatch(/^livespec guard: /);
		}
		expect(blocked("rm .pi/livespec/x").reason).toContain("human");
	});
});
