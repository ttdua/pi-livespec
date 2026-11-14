import { createHash } from "node:crypto";
import type { Unit } from "./change.ts";

/** Canonical field order; Difficulty, Tags and the status line are excluded. */
const FIELDS = ["Covers", "Files", "Done means", "Scenarios", "Depends", "Verify", "Kind"] as const;

function normalize(line: string): string {
	return line.replace(/\r/g, "").trimEnd();
}

export function unitDigest(u: Unit): string {
	const canonical = FIELDS.map((name) => {
		const lines = (u.raw[name] ?? []).map(normalize).filter((l) => l !== "");
		return `${name}:\n${lines.join("\n")}\n`;
	}).join("");
	return createHash("sha256").update(canonical).digest("hex");
}
