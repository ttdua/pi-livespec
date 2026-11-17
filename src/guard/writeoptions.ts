// The options each write command is known to accept (GNU and BSD), so the
// guard can resolve GNU long-option abbreviations and fail closed on an option
// it does not model (design D7 "Livespec project files").

import type { Word } from "./shell.ts";
import type { Scanned } from "./options.ts";

type Spec = { short: string; long: string };

const SPECS: Record<string, Spec> = {
	tee: { short: "aip", long: "append ignore-interrupts output-error help version" },
	rm: { short: "fiIrRdvPWx", long: "force interactive recursive dir verbose one-file-system no-preserve-root preserve-root help version" },
	rmdir: { short: "pv", long: "parents verbose ignore-fail-on-non-empty help version" },
	touch: { short: "acdfhmrtA", long: "time no-create date reference no-dereference help version" },
	mv: { short: "finuvbStTZx", long: "force interactive no-clobber update verbose backup suffix target-directory no-target-directory strip-trailing-slashes context exchange debug no-copy help version" },
	cp: {
		short: "abdfilLnpPrRsStTuvxZHcaXE",
		long: "archive attributes-only backup copy-contents no-dereference force interactive link dereference no-clobber preserve no-preserve parents recursive reflink remove-destination sparse strip-trailing-slashes symbolic-link suffix target-directory no-target-directory update verbose one-file-system context debug keep-directory-symlink help version",
	},
	ln: { short: "sfinvbStTrLPdF", long: "symbolic force interactive no-dereference verbose backup suffix target-directory no-target-directory relative logical physical directory help version" },
	install: { short: "bcCdDgmopsStTvZU", long: "backup compare directory create-leading group mode owner preserve-timestamps strip strip-program suffix target-directory no-target-directory verbose preserve-context context debug unprivileged help version" },
	sed: { short: "nefEirslbuza", long: "quiet silent expression file regexp-extended in-place line-length separate binary unbuffered null-data zero-terminated follow-symlinks debug posix sandbox help version" },
	perl: { short: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ", long: "help version" },
};

const LONG_NAMES = new Map(Object.entries(SPECS).map(([name, spec]) => [name, spec.long.split(" ").map((l) => `--${l}`)]));
const KNOWN = new Map(Object.entries(SPECS).map(([name, spec]) => [name, new Set([...[...spec.short].map((c) => `-${c}`), ...(LONG_NAMES.get(name) ?? [])])]));

/** `args` with each long option of the write command `name` spelled out in full: a unique prefix resolves (GNU getopt), `--opt=value` keeps its value. Others stay as written. */
export function normalizeLongOptions(name: string, args: Word[]): Word[] {
	const longs = LONG_NAMES.get(name);
	if (!longs) return args;
	const end = args.findIndex((w) => w.text === "--");
	return args.map((w, k) => (end >= 0 && k >= end ? w : expandLong(w, longs)));
}

function expandLong(w: Word, longs: string[]): Word {
	if (!w.text.startsWith("--") || w.text.length < 3) return w;
	const eq = w.text.indexOf("=");
	const given = eq < 0 ? w.text : w.text.slice(0, eq);
	if (longs.includes(given)) return w;
	const matches = longs.filter((l) => l.startsWith(given));
	if (matches.length !== 1) return w;
	return { ...w, text: (matches[0] as string) + (eq < 0 ? "" : w.text.slice(eq)) };
}

/** True when a scanned option of the write command `name` is not in its known list. */
export function hasUnknownOption(name: string, scanned: Scanned): boolean {
	const known = KNOWN.get(name);
	return known !== undefined && scanned.options.some((o) => !known.has(o.name));
}
