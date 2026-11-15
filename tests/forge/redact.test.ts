import { describe, expect, it } from "vitest";
import { ForgeError } from "../../src/forge/errors.ts";
import { RedactingForge } from "../../src/forge/redact.ts";
import type { Forge, Version } from "../../src/forge/types.ts";

const V = "v" as Version;

const TOKEN = "ghp_secret123";

/** Every `Forge` method with arguments that type-check; the stub throws for each. */
const CALLS: Record<string, (f: Forge) => Promise<unknown>> = {
	whoami: (f) => f.whoami(),
	getIssue: (f) => f.getIssue(1),
	searchIssues: (f) => f.searchIssues({ labels: [], state: "open" }),
	getPermission: (f) => f.getPermission("x"),
	createIssue: (f) => f.createIssue({ title: "t", body: "b", labels: [] }),
	updateIssueBody: (f) => f.updateIssueBody(1, "b", V),
	closeIssue: (f) => f.closeIssue(1),
	reopenIssue: (f) => f.reopenIssue(1),
	addLabels: (f) => f.addLabels(1, ["a"]),
	removeLabels: (f) => f.removeLabels(1, ["a"]),
	listComments: (f) => f.listComments(1),
	createComment: (f) => f.createComment(1, "b"),
	updateComment: (f) => f.updateComment("1", "b", V),
	findOpenPullRequest: (f) => f.findOpenPullRequest("h"),
	getPullRequest: (f) => f.getPullRequest(1),
	listPullRequests: (f) => f.listPullRequests({ state: "open" }),
	getPullRequestFiles: (f) => f.getPullRequestFiles(1),
	listReviews: (f) => f.listReviews(1),
	createPullRequest: (f) => f.createPullRequest({ head: "h", base: "b", title: "t", body: "b" }),
	updatePullRequest: (f) => f.updatePullRequest(1, { title: "t" }, V),
	listReviewComments: (f) => f.listReviewComments(1),
	createReviewComment: (f) => f.createReviewComment(1, { path: "p", line: 1, body: "b" }),
	getChecks: (f) => f.getChecks("r"),
};

/** A forge whose every method rejects with a `ForgeError` echoing the token. */
function leakyForge(): Forge {
	const stub: Record<string, unknown> = { kind: "github" };
	for (const name of Object.keys(CALLS)) {
		stub[name] = async () => {
			throw new ForgeError({ code: "auth", operation: name, status: 401, message: `gh: bad credentials for token ${TOKEN}` });
		};
	}
	return stub as unknown as Forge;
}

describe("RedactingForge", () => {
	it("RedactingForge redacts tokens in thrown errors of every operation", async () => {
		const forge = new RedactingForge(leakyForge(), () => [TOKEN]);
		expect(forge.kind).toBe("github");
		for (const [name, call] of Object.entries(CALLS)) {
			const error = await call(forge).then(
				() => undefined,
				(e: unknown) => e,
			);
			expect(error, name).toBeInstanceOf(ForgeError);
			const e = error as ForgeError;
			expect(e.message, name).toBe("gh: bad credentials for token ***");
			expect(e.code, name).toBe("auth");
			expect(e.operation, name).toBe(name);
			expect(e.status, name).toBe(401);
		}
	});

	it("redacts a thrown non-Error value", async () => {
		const inner = leakyForge() as unknown as Record<string, unknown>;
		inner.getIssue = async () => {
			throw `gh failed with ${TOKEN}`;
		};
		const forge = new RedactingForge(inner as unknown as Forge, () => [TOKEN]);
		const error = await forge.getIssue(1).then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("gh failed with ***");
	});

	it("passes results and non-forge errors through", async () => {
		const inner = leakyForge() as unknown as Record<string, unknown>;
		inner.whoami = async () => ({ login: "ttdua" });
		inner.getIssue = async () => {
			throw new Error(`plain ${TOKEN}`);
		};
		const forge = new RedactingForge(inner as unknown as Forge, () => [TOKEN]);
		await expect(forge.whoami()).resolves.toEqual({ login: "ttdua" });
		await expect(forge.getIssue(1)).rejects.toThrow("plain ***");
	});
});
