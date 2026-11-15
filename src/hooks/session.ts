// The livespec session: derived data for the current pi session, rebuilt from
// the forge and git, plus the `session_start` hook. Each start step is its own
// function that catches its own errors and records them on the Session, so the
// hook never throws into pi.

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { messageOf } from "../core/messages.ts";
import { formatOutcome } from "../commands/skills.ts";
import { type LoadedConfig, loadConfig } from "../config.ts";
import { ContentManager, type UpgradeOutcome } from "../content/manager.ts";
import { createMirror } from "../content/mirror.ts";
import { contentPaths } from "../content/paths.ts";
import { workInProgress } from "../content/wip.ts";
import { advancePhase } from "../engine/advance.ts";
import { CommentsCache } from "../engine/comments-cache.ts";
import { defaultGitExec } from "../engine/git-exec.ts";
import { createGit, type Git } from "../engine/git.ts";
import { DEFAULT_PACK_FILE, loadPack } from "../engine/pack-load.ts";
import type { LoadedPack } from "../engine/pack-types.ts";
import { CachedForge } from "../forge/cache.ts";
import { detectForge, parseRemote } from "../forge/detect.ts";
import { buildCardInput } from "./card-input.ts";
import { type CardInput, renderCard } from "./phase-card.ts";
import { appendResumeEntry, registerResumeRenderer } from "./resume-entry.ts";
import { setSession } from "./session-store.ts";
import { SkillReads } from "./skill-reads.ts";

export type SessionDeps = { home: string; detect: typeof detectForge; content: (home: string) => ContentManager; now: () => Date };

export const AGENT_SKILLS_SOURCE = "https://github.com/addyosmani/agent-skills.git";
const NOT_CONNECTED = "the forge is not connected yet";
const RELOAD_HINT = "The new skills apply after /reload or in the next session.";
const INIT_HINT = "This project does not use livespec yet. Run /livespec init to set it up.";
const MIGRATE_HINT = "This project has an openspec/ folder. Run /livespec migrate-openspec, then /livespec init.";
const OPENSPEC_DIR = "openspec";
const MAX_RECORDED_ERRORS = 50;
/** Without a forge, work in progress is unknown, so no upgrade runs; the skip is recorded and notified. */
const NO_FORGE_SKIP = "forge unavailable; work in progress unknown";

/** The real home, forge detection, content manager and clock. */
export function defaultSessionDeps(): SessionDeps {
	return {
		home: homedir(),
		detect: detectForge,
		content: (home) => {
			const paths = contentPaths(home);
			return new ContentManager({ paths, mirror: createMirror(paths, defaultGitExec), now: () => new Date(), source: AGENT_SKILLS_SOURCE });
		},
		now: () => new Date(),
	};
}

export class Session {
	config: LoadedConfig = { project: null, user: { agentSkills: { channel: "auto" } }, warnings: [] };
	pack: LoadedPack = { ok: false, errors: [] };
	forge?: CachedForge;
	comments?: CommentsCache;
	/** Why the forge is not connected, for the card. */
	forgeError?: string;
	activeTree?: string;
	card: CardInput;
	/** The change last resolved for a branch, reused while the forge is offline. */
	lastResolved?: { branch: string; number: number };
	/** The background agent-skills check started at session start. */
	upgrade?: Promise<void>;
	readonly skillReads = new SkillReads();
	/** Errors each step caught; the session keeps working without the failed part. */
	readonly errors: string[] = [];
	private first = true;

	constructor(
		readonly cwd: string,
		readonly git: Git,
	) {
		this.card = { first: true, constraintsTemplate: false, unnotedSkills: [], kind: "forge-unavailable", message: NOT_CONNECTED };
	}

	get initialized(): boolean {
		return this.config.project !== null;
	}

	/** Keeps the last MAX_RECORDED_ERRORS, so a long session with the forge down does not grow without bound. */
	record(step: string, error: unknown): string {
		const message = `${step}: ${messageOf(error)}`;
		this.errors.push(message);
		if (this.errors.length > MAX_RECORDED_ERRORS) this.errors.splice(0, this.errors.length - MAX_RECORDED_ERRORS);
		return message;
	}

	/** The first card the model sees points at specs/product.md; later ones do not. Called by the `context` hook. */
	firstCardShown(): void {
		this.first = false;
		this.card = { ...this.card, first: false };
	}

	get isFirstCard(): boolean {
		return this.first;
	}

	/** Rebuilds the card, applying an automatic advance once. Never throws. */
	async refresh(): Promise<void> {
		if (!this.initialized) return;
		await resolveAndSnapshot(this);
		if (await applyAdvance(this)) await resolveAndSnapshot(this);
	}
}

/**
 * Resolves the change and rebuilds the card. When the forge or git cannot be read (auth expired
 * mid-session, transport failure), the card says the forge is unavailable with the reason, and the
 * agent keeps working.
 */
async function resolveAndSnapshot(session: Session): Promise<void> {
	try {
		session.card = await buildCardInput({ session, first: session.isFirstCard });
	} catch (error) {
		const message = session.record("refresh", error);
		session.card = { ...cardBasics(session.card), kind: "forge-unavailable", message };
	}
}

function cardBasics(card: CardInput): Pick<CardInput, "first" | "constraintsTemplate" | "unnotedSkills"> {
	return { first: card.first, constraintsTemplate: card.constraintsTemplate, unnotedSkills: card.unnotedSkills };
}

/** Moves the change when `nextStep` reports an advance and the forge is writable. True when the issue moved. */
async function applyAdvance(session: Session): Promise<boolean> {
	const card = session.card;
	const forge = session.forge;
	if (card.kind !== "change" || card.step.advance === undefined || card.state.readOnly || !forge || !session.pack.ok) return false;
	try {
		const r = await advancePhase(forge, card.state.issue.number, card.step.advance, session.pack.pack);
		if (r.status === "refused") session.record("advance", r.reason);
		return r.status === "moved";
	} catch (error) {
		session.record("advance", error);
		return false;
	}
}

/** A pack load that throws (an unreadable file) becomes a pack error, so the card and tools show the reason. */
async function loadSessionPack(session: Session): Promise<void> {
	try {
		session.pack = await loadPack(session.cwd);
	} catch (error) {
		const message = session.record("load", error);
		session.pack = { ok: false, errors: [{ severity: "error", file: DEFAULT_PACK_FILE, line: 1, col: 1, path: "", message }] };
	}
}

async function loadSessionBasics(session: Session, d: SessionDeps, content: ContentManager): Promise<void> {
	try {
		session.config = await loadConfig(session.cwd, d.home);
		if (!session.initialized) return;
		await loadSessionPack(session);
	} catch (error) {
		session.record("load", error);
	}
	try {
		session.activeTree = await content.activeTree();
	} catch (error) {
		session.record("agent-skills", error);
	}
}

async function originRemote(root: string): Promise<{ host: string; owner: string; repo: string }> {
	const r = await defaultGitExec(["remote", "get-url", "origin"], { cwd: root });
	const remote = r.code === 0 ? parseRemote(r.stdout) : null;
	if (!remote) throw new Error(`cannot parse the origin remote of ${root}`);
	return remote;
}

async function connectForge(session: Session, d: SessionDeps): Promise<void> {
	try {
		const inner = await d.detect(session.cwd);
		const { host, owner, repo } = await originRemote(session.cwd);
		const cacheRoot = join(d.home, ".pi", "agent", "livespec", "cache");
		session.forge = new CachedForge(inner, { cacheRoot, host, owner, repo });
		session.comments = new CommentsCache({ dir: join(cacheRoot, host, owner, repo), now: () => d.now().getTime() });
	} catch (error) {
		session.forgeError = session.record("forge", error);
	}
}

function safeNotify(ctx: ExtensionContext, message: string, type: "info" | "warning"): void {
	try {
		ctx.ui.notify(message, type);
	} catch {
		// The UI is gone (pi shutting down); a notice has nowhere to go.
	}
}

/**
 * UI-only: a custom entry never reaches the LLM, which sees the card only through the `context` hook.
 * So the resume entry does not consume the first card; the `context` hook marks it shown.
 */
function showResumeCard(pi: ExtensionAPI, session: Session): void {
	try {
		appendResumeEntry(pi, renderCard(session.card));
	} catch (error) {
		session.record("resume", error);
	}
}

function upgradeNotice(o: UpgradeOutcome): { message: string; type: "info" | "warning" } | undefined {
	if (o.kind === "skipped") return undefined;
	const message = formatOutcome(o);
	if (o.kind === "installed") return { message: `${message}\n${RELOAD_HINT}`, type: "info" };
	return { message, type: o.kind === "notified" ? "info" : "warning" };
}

async function runUpgrade(session: Session, content: ContentManager, ctx: ExtensionContext): Promise<void> {
	if (!session.pack.ok) return;
	if (!session.forge) {
		safeNotify(ctx, `agent-skills check skipped: ${session.record("agent-skills", NO_FORGE_SKIP)}`, "info");
		return;
	}
	try {
		const wip = await workInProgress(session.forge);
		const notice = upgradeNotice(await content.autoCheck(session.pack.pack, session.config.user.agentSkills.channel, wip));
		if (notice) safeNotify(ctx, notice.message, notice.type);
	} catch (error) {
		safeNotify(ctx, `agent-skills check failed: ${session.record("agent-skills", error)}`, "warning");
	}
}

/** Starts the agent-skills check in the background; the hook never awaits it. */
function kickOffUpgrade(session: Session, content: ContentManager, ctx: ExtensionContext): void {
	if (!session.pack.ok) return;
	session.upgrade = runUpgrade(session, content, ctx);
}

/** One notice for an uninitialized project; nothing runs and no file changes. */
async function suggestInit(session: Session, ctx: ExtensionContext): Promise<void> {
	const hasOpenSpec = await stat(join(session.cwd, OPENSPEC_DIR)).then(
		(s) => s.isDirectory(),
		() => false,
	);
	safeNotify(ctx, hasOpenSpec ? MIGRATE_HINT : INIT_HINT, "info");
}

async function startSession(pi: ExtensionAPI, d: SessionDeps, ctx: ExtensionContext): Promise<void> {
	const session = new Session(ctx.cwd, createGit(ctx.cwd));
	setSession(session);
	const content = d.content(d.home);
	await loadSessionBasics(session, d, content);
	if (!session.initialized) return suggestInit(session, ctx);
	await connectForge(session, d);
	await session.refresh();
	showResumeCard(pi, session);
	kickOffUpgrade(session, content, ctx);
}

export function registerSessionHooks(pi: ExtensionAPI, d: Partial<SessionDeps> = {}): void {
	const deps: SessionDeps = { ...defaultSessionDeps(), ...d };
	registerResumeRenderer(pi);
	pi.on("session_start", async (_event, ctx) => {
		try {
			await startSession(pi, deps, ctx);
		} catch (error) {
			safeNotify(ctx, `livespec could not start: ${messageOf(error)}`, "warning");
		}
	});
}
