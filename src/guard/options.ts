// A generic command-line option scanner for the guard: splits words into
// options (with their values) and operands, for wrappers and forge CLIs alike.

import type { Word } from "./shell.ts";

export type Option = { name: string; value?: Word };
export type Scanned = { options: Option[]; operands: Word[] };

export const set = (...names: string[]): ReadonlySet<string> => new Set(names);

/**
 * Splits arguments into options and operands. `valued` options take a value
 * (attached or the next word). With `stopAtOperand`, everything from the first
 * operand on is an operand, as for wrappers and global options.
 */
export function scanOptions(args: Word[], valued: ReadonlySet<string>, stopAtOperand: boolean): Scanned {
	const options: Option[] = [];
	const operands: Word[] = [];
	for (let k = 0; k < args.length; k++) {
		const w = args[k] as Word;
		if (w.text === "--") {
			operands.push(...args.slice(k + 1));
			break;
		}
		if (!w.text.startsWith("-") || w.text === "-") {
			if (stopAtOperand) {
				operands.push(...args.slice(k));
				break;
			}
			operands.push(w);
			continue;
		}
		k += w.text.startsWith("--") ? readLong(w, args[k + 1], valued, options) : readShort(w, args[k + 1], valued, options);
	}
	return { options, operands };
}

/** Records one long option; returns 1 when it consumed the next word. */
function readLong(w: Word, next: Word | undefined, valued: ReadonlySet<string>, out: Option[]): number {
	const eq = w.text.indexOf("=");
	if (eq > 0) {
		out.push({ name: w.text.slice(0, eq), value: { ...w, text: w.text.slice(eq + 1) } });
		return 0;
	}
	return pushValued(w.text, next, valued, out);
}

/** Records a short cluster such as `-sXPOST`; returns 1 when it consumed the next word. */
function readShort(w: Word, next: Word | undefined, valued: ReadonlySet<string>, out: Option[]): number {
	for (let j = 1; j < w.text.length; j++) {
		const name = `-${w.text[j]}`;
		const rest = w.text.slice(j + 1);
		if (!valued.has(name)) out.push({ name });
		else if (rest !== "") {
			out.push({ name, value: { ...w, text: rest } });
			return 0;
		} else return pushValued(name, next, valued, out);
	}
	return 0;
}

function pushValued(name: string, next: Word | undefined, valued: ReadonlySet<string>, out: Option[]): number {
	if (!valued.has(name) || !next) {
		out.push({ name });
		return 0;
	}
	out.push({ name, value: next });
	return 1;
}

export function optionValues(scanned: Scanned, names: ReadonlySet<string>): Word[] {
	return scanned.options.filter((o) => names.has(o.name) && o.value).map((o) => o.value as Word);
}

/** True when any option is named in `names`; a name ending in `*` matches by prefix. */
export function hasOption(scanned: Scanned, names: ReadonlySet<string>): boolean {
	return scanned.options.some((o) => names.has(o.name) || [...names].some((n) => n.endsWith("*") && o.name.startsWith(n.slice(0, -1))));
}
