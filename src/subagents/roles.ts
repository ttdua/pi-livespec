// Role catalogue: agent names, review subjects and the result schemas each role must return.

export type Role = "scout" | "implementer" | "reviewer" | "verifier";
export type ReviewSubject = "spec" | "plan" | "unit" | "change" | `persona:${string}`;

export type SubagentEntry = {
	role: Role;
	subject?: ReviewSubject;
	mode: "off" | "always" | "auto";
	when?: string[];
	advisory?: boolean;
	skills?: string[];
};

export type Finding = {
	severity: "CRITICAL" | "WARNING" | "SUGGESTION";
	kind: "defect" | "missed-context" | "lowered-standard" | "files-violation" | "other";
	location: string;
	evidence: string;
	fix: string;
	scope: "unit" | "in-change" | "out-of-scope" | "needs-decision";
};

export type SubagentResult = {
	status: "DONE" | "DONE_WITH_CONCERNS" | "BLOCKED" | "NEEDS_CONTEXT";
	notes: string;
	discoveries: string[];
	sources_used: string[];
	reason?: string;
	evidence?: string;
	commits?: string[];
	findings?: Finding[];
};

/** The subset of JSON Schema the executor accepts. */
export type JsonSchema = {
	type?: "object" | "array" | "string";
	enum?: string[];
	properties?: Record<string, JsonSchema>;
	items?: JsonSchema;
	required?: string[];
	additionalProperties?: boolean;
};

export const AGENT_OF: Record<Role, string> = {
	scout: "scout",
	implementer: "implementer",
	reviewer: "reviewer",
	verifier: "verifier",
};

export const ROLE_SUBJECTS: readonly ReviewSubject[] = ["spec", "plan", "unit", "change"];

const STRING: JsonSchema = { type: "string" };
const STRING_LIST: JsonSchema = { type: "array", items: STRING };

export const FINDING_SCHEMA: JsonSchema = {
	type: "object",
	properties: {
		severity: { type: "string", enum: ["CRITICAL", "WARNING", "SUGGESTION"] },
		kind: { type: "string", enum: ["defect", "missed-context", "lowered-standard", "files-violation", "other"] },
		location: STRING,
		evidence: STRING,
		fix: STRING,
		scope: { type: "string", enum: ["unit", "in-change", "out-of-scope", "needs-decision"] },
	},
	required: ["severity", "kind", "location", "evidence", "fix", "scope"],
	additionalProperties: false,
};

const BASE_PROPERTIES: Record<string, JsonSchema> = {
	status: { type: "string", enum: ["DONE", "DONE_WITH_CONCERNS", "BLOCKED", "NEEDS_CONTEXT"] },
	notes: STRING,
	discoveries: STRING_LIST,
	sources_used: STRING_LIST,
	reason: STRING,
	evidence: STRING,
};
const BASE_REQUIRED = ["status", "notes", "discoveries", "sources_used"];

/** The structured result a role's child must submit; `implementer` adds commits, `reviewer` and `verifier` add findings. */
export function resultSchema(role: Role): JsonSchema {
	if (role === "implementer") {
		return object({ ...BASE_PROPERTIES, commits: STRING_LIST }, [...BASE_REQUIRED, "commits"]);
	}
	if (role === "reviewer" || role === "verifier") {
		return object({ ...BASE_PROPERTIES, findings: { type: "array", items: FINDING_SCHEMA } }, [...BASE_REQUIRED, "findings"]);
	}
	return object(BASE_PROPERTIES, BASE_REQUIRED);
}

function object(properties: Record<string, JsonSchema>, required: string[]): JsonSchema {
	return { type: "object", properties, required, additionalProperties: false };
}
