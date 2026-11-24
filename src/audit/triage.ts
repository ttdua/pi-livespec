// Re-triage of drift items by writers' `/livespec triage <key> major|minor|ignore` comments on the initiative.

import type { Comment } from "../forge/types.ts";
import type { ClassifiedItem, Route, Severity } from "./severity.ts";

export type Triaged = { items: ClassifiedItem[]; ignored: string[]; unmatched: string[] };

type Verdict = Severity | "ignore";
type Command = { key: string; verdict: Verdict; author: string };

/** First line `/livespec triage <key> <verdict>`; the key may hold any non-space character. */
const TRIAGE = /^\/livespec triage (\S+) (major|minor|ignore)\s*$/;
const ROUTE: Record<Severity, Route> = { major: "change", minor: "small-fix" };

function parseTriage(c: Comment): Command | undefined {
	const first = c.body.split("\n", 1)[0] ?? "";
	const m = TRIAGE.exec(first.trim());
	return m ? { key: m[1] as string, verdict: m[2] as Verdict, author: c.author } : undefined;
}

/** The latest command per key from authors with write access, in comment order; each author's permission is read once. */
async function latestCommands(comments: Comment[], canWrite: (login: string) => Promise<boolean>): Promise<Map<string, Command>> {
	const allowed = new Map<string, boolean>();
	const latest = new Map<string, Command>();
	for (const command of comments.map(parseTriage)) {
		if (command === undefined) continue;
		if (!allowed.has(command.author)) allowed.set(command.author, await canWrite(command.author));
		if (allowed.get(command.author)) latest.set(command.key, command);
	}
	return latest;
}

const retriaged = (item: ClassifiedItem, c: Command & { verdict: Severity }): ClassifiedItem => ({
	...item, severity: c.verdict, route: ROUTE[c.verdict], retriaged: { by: c.author, from: item.severity },
});

/** Applies the latest writer command per key: `major`/`minor` re-triage the item, `ignore` moves it to `ignored`. */
export async function applyTriage(items: ClassifiedItem[], comments: Comment[], canWrite: (login: string) => Promise<boolean>): Promise<Triaged> {
	const commands = await latestCommands(comments, canWrite);
	const out: Triaged = { items: [], ignored: [], unmatched: [...commands.keys()].filter((k) => !items.some((i) => i.key === k)) };
	for (const item of items) {
		const c = commands.get(item.key);
		if (c === undefined) out.items.push(item);
		else if (c.verdict === "ignore") out.ignored.push(item.key);
		else out.items.push(retriaged(item, { ...c, verdict: c.verdict }));
	}
	return out;
}
