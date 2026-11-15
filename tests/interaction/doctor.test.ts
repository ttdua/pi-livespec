import { describe, expect, test } from "vitest";
import type { DoctorDeps } from "../../src/commands/doctor.ts";
import type { LoadedConfig } from "../../src/config.ts";
import type { Forge } from "../../src/forge/types.ts";
import { checkApprover } from "../../src/interaction/doctor.ts";

const DEFAULT_CONFIG: LoadedConfig = { project: null, user: { agentSkills: { channel: "auto" } }, warnings: [] };

function deps(over: { config?: LoadedConfig; hasUI: boolean; forge?: "writable" | "read-only" | "missing"; accountBlock?: string }): DoctorDeps {
	const forge = over.forge ?? "missing";
	return {
		config: over.config ?? DEFAULT_CONFIG,
		hasUI: over.hasUI,
		forge: async () => {
			if (forge === "missing") throw new Error("no forge");
			return { forge: {} as Forge, readOnly: forge === "read-only" };
		},
		...(over.accountBlock !== undefined ? { accountBlock: over.accountBlock } : {}),
	} as unknown as DoctorDeps;
}

describe("approver doctor check", () => {
	test("Doctor names the adapter", async () => {
		const results = await checkApprover(deps({ hasUI: true }));
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ id: "approver", status: "ok" });
		expect(results[0]?.message).toContain("chain [in-session]");
		expect(results[0]?.message).toContain("source default");
		expect(results[0]?.message).toContain("in-session answers now");
	});

	test("doctor errors when no adapter is available", async () => {
		const results = await checkApprover(deps({ hasUI: false }));
		expect(results[0]).toMatchObject({ id: "approver", status: "error" });
		expect(results[0]?.message).toContain("no adapter in the chain is available");
		expect(results[0]?.suggestion).toContain("interaction.adapter");
	});

	test("a project chain falls through to a writable forge", async () => {
		const config: LoadedConfig = { ...DEFAULT_CONFIG, project: { interaction: { adapter: ["in-session", "forge"] } } as LoadedConfig["project"] };
		const ok = await checkApprover(deps({ config, hasUI: false, forge: "writable" }));
		expect(ok[0]?.message).toContain("chain [in-session, forge], source project; forge answers now");
		const blocked = await checkApprover(deps({ config, hasUI: false, forge: "writable", accountBlock: "nope" }));
		expect(blocked[0]?.status).toBe("error");
	});
});
