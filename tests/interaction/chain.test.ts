import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { adapterChain, loadConfig } from "../../src/config.ts";
import type {
	AdapterName,
	Answered,
	ApprovalRequest,
	Approver,
	Deferred,
	Pending,
} from "../../src/interaction/approver.ts";
import { runChain } from "../../src/interaction/chain.ts";

const request: ApprovalRequest = {
	id: "question-Q1.abc",
	kind: "question",
	subject: "question:Q1",
	record: {
		id: "question-Q1.abc",
		kind: "question",
		subject: "question:Q1",
		mode: "blocking",
		head_sha: "deadbeef",
		snapshot: { id: "Q1", text: "Which limit?", requirements: [] },
		summary: "Which limit?",
	},
	change: 7,
	phase: "define",
	summary: "Which limit?",
	links: [],
	files: [],
	mode: "blocking",
	question: { id: "Q1", class: "blocking", requirements: [] },
};

const answered = (adapter: AdapterName): Answered => ({
	status: "answered",
	outcome: "approved",
	notes: "",
	by: "alice",
	at: "2026-11-15T00:00:00.000Z",
	adapter,
});

interface FakeApprover extends Approver {
	received: ApprovalRequest[];
}

function fake(name: AdapterName, available: boolean, result: Answered | Pending | Deferred): FakeApprover {
	const received: ApprovalRequest[] = [];
	return {
		name,
		received,
		available: () => available,
		request: async (r) => {
			received.push(r);
			return result;
		},
		poll: async () => ({ status: "pending" }),
	};
}

const deferred: Deferred = { status: "deferred", questionClass: "non-blocking" };
const noHooks = { onDeferred: async () => {} };

describe("adapter chain", () => {
	test("Default chain", async () => {
		const root = mkdtempSync(join(tmpdir(), "ls-chain-root-"));
		const home = mkdtempSync(join(tmpdir(), "ls-chain-home-"));
		try {
			const config = await loadConfig(root, home);
			expect(adapterChain(config)).toEqual({ chain: ["in-session"], source: "default" });
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("No adapter available", async () => {
		const inSession = fake("in-session", false, answered("in-session"));
		const result = await runChain(["in-session"], { "in-session": inSession }, request, noHooks);
		expect(result.status).toBe("refused");
		expect(result.status === "refused" && result.message).toContain("interaction.adapter");
		expect(inSession.received).toEqual([]);
	});

	test("missing adapter instance counts as unavailable", async () => {
		const result = await runChain(["forge"], {}, request, noHooks);
		expect(result.status).toBe("refused");
	});

	test("first available adapter is used", async () => {
		const inSession = fake("in-session", false, answered("in-session"));
		const forge = fake("forge", true, { status: "pending", requestId: "question-Q1.abc" });
		const result = await runChain(["in-session", "forge"], { "in-session": inSession, forge }, request, noHooks);
		expect(result).toEqual({ status: "pending", requestId: "question-Q1.abc" });
		expect(inSession.received).toEqual([]);
		expect(forge.received).toEqual([request]);
	});

	test("answer from the first adapter stops the chain", async () => {
		const inSession = fake("in-session", true, answered("in-session"));
		const forge = fake("forge", true, { status: "pending", requestId: "x" });
		const result = await runChain(["in-session", "forge"], { "in-session": inSession, forge }, request, noHooks);
		expect(result).toEqual(answered("in-session"));
		expect(forge.received).toEqual([]);
	});

	test("answer later moves on to the next adapter", async () => {
		const inSession = fake("in-session", true, deferred);
		const forge = fake("forge", true, { status: "pending", requestId: "question-Q1.abc" });
		let deferredCalls = 0;
		const hooks = {
			onDeferred: async () => {
				deferredCalls += 1;
			},
		};
		const result = await runChain(["in-session", "forge"], { "in-session": inSession, forge }, request, hooks);
		expect(result).toEqual({ status: "pending", requestId: "question-Q1.abc" });
		expect(deferredCalls).toBe(1);
		expect(forge.received).toHaveLength(1);
		expect(forge.received[0].mode).toBe("async");
		expect(request.mode).toBe("blocking");
	});

	test("answer later with no further adapter returns deferred-all", async () => {
		const inSession = fake("in-session", true, deferred);
		let deferredCalls = 0;
		const hooks = {
			onDeferred: async () => {
				deferredCalls += 1;
			},
		};
		const result = await runChain(["in-session"], { "in-session": inSession }, request, hooks);
		expect(result).toEqual({ status: "deferred-all" });
		expect(deferredCalls).toBe(1);
	});
});
