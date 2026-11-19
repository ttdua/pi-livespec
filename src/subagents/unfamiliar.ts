// The `unfamiliar-code` policy fact, read once at refresh from the living specs so `nextStep` stays pure.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Change } from "../core/change.ts";
import { parseSpec, type Spec } from "../core/spec.ts";
import { unfamiliarCode } from "./policy.ts";

/** `change` for shape, define and plan; `units` per unit id for build. */
export type UnfamiliarFacts = { change: boolean; units: Record<string, boolean> };

const SPECS_DIR = "specs";
const SPEC_FILE = "spec.md";

async function readSpec(root: string, capability: string): Promise<Spec | undefined> {
	try {
		return parseSpec(await readFile(join(root, SPECS_DIR, capability, SPEC_FILE), "utf8"), capability);
	} catch {
		return undefined;
	}
}

async function capabilityNames(root: string): Promise<string[]> {
	try {
		return (await readdir(join(root, SPECS_DIR), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return [];
	}
}

/** Every readable living spec under `<root>/specs/<capability>/spec.md`. */
async function readSpecs(root: string): Promise<Spec[]> {
	const read = await Promise.all((await capabilityNames(root)).map((name) => readSpec(root, name)));
	return read.filter((s): s is Spec => s !== undefined);
}

/** The condition for `phase`: per unit in build, once for the change in the other phases. */
export async function readUnfamiliar(root: string, phase: string, change: Change): Promise<UnfamiliarFacts> {
	const specs = await readSpecs(root);
	const caps = change.header.capabilities;
	const capabilities = caps ? [...caps.new, ...caps.modified] : [];
	return {
		change: unfamiliarCode(phase === "build" ? "plan" : phase, undefined, specs, capabilities),
		units: Object.fromEntries(change.units.map((u) => [u.id, unfamiliarCode("build", u, specs, capabilities)])),
	};
}
