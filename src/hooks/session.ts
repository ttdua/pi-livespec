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
import { defaultGitExec, type GitExec } from "../engine/git-exec.ts";
import { createGit, type Git } from "../engine/git.ts";
import { clearGateMemo } from "../engine/registry.ts";
import { DEFAULT_PACK_FILE, loadPack } from "../engine/pack-load.ts";
import type { LoadedPack } from "../engine/pack-types.ts";
import { defaultAccountEnv } from "../accounts/env.ts";
import { readOnlyLogin } from "../accounts/read-only.ts";
import { redactTokens } from "../accounts/redact.ts";
import { candidateToken } from "../accounts/token.ts";
import { type AccountUI, chooseAccount, envTokenVar, type ResolvedAccount, resolveAccount } from "../accounts/resolve.ts";
import type { AccountEnv } from "../accounts/types.ts";
import { CachedForge } from "../forge/cache.ts";
import { type DetectDeps, detectForge, type ForgeTarget, resolveForgeTarget } from "../forge/detect.ts";
import { ForgeError } from "../forge/errors.ts";
import { RedactingForge } from "../forge/redact.ts";
import { drainEvidenceLocks } from "../evidence/lock.ts";
import { pollApprovals } from "../interaction/poll.ts";
import { type FeedbackPollResult, pollFeedback } from "../ship/feedback-poll.ts";
import { isChildSession } from "../subagents/child.ts";
import { buildCardInput, cardAccount } from "./card-input.ts";
import { type CardInput, renderCard, untrusted } from "./phase-card.ts";
import { appendResumeEntry, registerResumeRenderer } from "./resume-entry.ts";
import { getSession, setSession } from "./session-store.ts";
import { SkillReads } from "./skill-reads.ts";

export type SessionDeps = {
	home: string;
	detect: typeof detectForge;
	content: (home: string) => ContentManager;
	now: () => Date;
	/** Every account I/O (gh, git config, access check, tea config). */
	accounts: AccountEnv;
};

export const AGENT_SKILLS_SOURCE = "https://github.com/addyosmani/agent-skills.git";
const NOT_CONNECTED = "the forge is not connected yet";
const NOT_BOUND = "the session has not started";
const SWITCH_COMMAND = "/livespec account <name>";
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
		accounts: defaultAccountEnv(),
	};
}

export class Session {
	config: LoadedConfig = { project: null, user: { agentSkills: { channel: "auto" }, lanes: 3, packetBudgetTokens: 24000, isolation: { excludePackages: [] } }, warnings: [] };
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
	/** The forge endpoint of `origin`, shared by account resolution and the adapter. */
	target?: ForgeTarget;
	/** The last account resolution of this session. */
	account?: ResolvedAccount;
	/** Why every forge mutation is refused; independent of the read-only mode, lifted only by a new resolution. */
	accountBlock?: string;
	/** The one-time line announcing a stored choice; cleared by `firstCardShown()`. */
	accountNotice?: string;
	/** Command comments the last approval poll ignored, with the reason; copied into the change state. */
	commandWarnings: string[] = [];
	/** Turns completed and the context usage after the last one; the card input copies them into `ChangeState.subagents`. */
	readonly mainTurns: { turnsCompleted: number; contextPercent?: number } = { turnsCompleted: 0 };
	/** The approval poll in flight; concurrent callers share it, so one answer completes once per session. */
	pollInFlight?: Promise<void>;
	/** The pull request feedback poll in flight; concurrent callers share it, so feedback becomes one round per session. */
	feedbackPollInFlight?: Promise<FeedbackPollResult>;
	private first = true;
	private link?: SessionLink;
	/** Every token the forge adapter can send, as the `RedactingForge` uses them; set by `connect`. */
	private tokens: string[] = [];
	private readonly shutdown = new AbortController();

	/**
	 * @param exec the runner `git` was built with; tools that run git outside `Git` (the guarded push)
	 * use it so tests can record and fake every git call of the session.
	 */
	constructor(
		readonly cwd: string,
		readonly git: Git,
		readonly exec: GitExec = defaultGitExec,
	) {
		this.card = { first: true, constraintsTemplate: false, unnotedSkills: [], kind: "forge-unavailable", message: NOT_CONNECTED };
	}

	get initialized(): boolean {
		return this.config.project !== null;
	}

	/** The tokens redacted from forge errors and from captured `Verify` output. */
	redactionTokens(): string[] {
		return [...this.tokens];
	}

	/** Kept by `connectForge`; never rendered. */
	setRedactionTokens(tokens: string[]): void {
		this.tokens = [...tokens];
	}

	/** The forge endpoint of `origin`, for the guard's endpoint list. */
	forgeTarget(): ForgeTarget | undefined {
		return this.target;
	}

	/** Aborted by `session_shutdown`; every `Verify` run listens to it. */
	get shutdownSignal(): AbortSignal {
		return this.shutdown.signal;
	}

	/** Aborts running `Verify` processes; called by the `session_shutdown` handler. */
	abortEvidence(): void {
		this.shutdown.abort();
	}

	/** Resolves once every queued or running evidence call has finished, cleanup included. */
	drainEvidence(): Promise<void> {
		return drainEvidenceLocks();
	}

	/** Keeps the last MAX_RECORDED_ERRORS, so a long session with the forge down does not grow without bound. */
	record(step: string, error: unknown): string {
		const message = `${step}: ${messageOf(error)}`;
		this.errors.push(message);
		if (this.errors.length > MAX_RECORDED_ERRORS) this.errors.splice(0, this.errors.length - MAX_RECORDED_ERRORS);
		return message;
	}

	/**
	 * The first card the model sees points at specs/product.md and carries the account notice; later
	 * ones do not. The cached card drops the notice line and keeps the block. Called by the `context` hook.
	 */
	firstCardShown(): void {
		this.first = false;
		this.accountNotice = undefined;
		this.card = { ...this.card, first: false, account: cardAccount(this) };
	}

	/** Connects later calls of `reconnect` to the deps and UI of session start. */
	bind(link: SessionLink): void {
		this.link = link;
	}

	/** Re-runs target, account resolution, adapter and identity steps, then rebuilds the card. Never throws. */
	async reconnect(): Promise<void> {
		await this.connect();
	}

	/** Connects with `chosen` when given (an explicit switch already resolved it), else runs the selection. */
	private async connect(chosen?: ResolvedAccount): Promise<void> {
		if (!this.link) {
			this.record("account", NOT_BOUND);
			return;
		}
		await connectForge(this, this.link, chosen);
		await this.refresh();
	}

	/** `/livespec account <name>`: stores `name` when it can push, then reconnects with that resolution. Never throws. */
	async switchAccount(name: string): Promise<{ ok: boolean; message: string }> {
		const target = this.target;
		if (!this.link || !target) return { ok: false, message: `${NOT_CONNECTED}: ${this.forgeError === undefined ? NOT_BOUND : untrusted(this.forgeError)}` };
		const chosen = await chooseAccount(target, this.cwd, name, this.link.deps.accounts);
		if (!chosen.ok) return chosen;
		await this.connect(chosen.resolved);
		if (this.forge === undefined) return { ok: false, message: `${name} was stored, but the forge could not be connected: ${this.forgeError === undefined ? NOT_CONNECTED : untrusted(this.forgeError)}` };
		if (this.accountBlock !== undefined) return { ok: false, message: this.accountBlock };
		return { ok: true, message: chosen.resolved.notice ?? `livespec uses \`${name}\` for this repository` };
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
		session.card = { ...cardBasics(session.card), account: cardAccount(session), kind: "forge-unavailable", message };
	}
}

function cardBasics(card: CardInput): Pick<CardInput, "first" | "constraintsTemplate" | "unnotedSkills"> {
	return { first: card.first, constraintsTemplate: card.constraintsTemplate, unnotedSkills: card.unnotedSkills };
}

/** Moves the change when `nextStep` reports an advance and the forge is writable. True when the issue moved. */
async function applyAdvance(session: Session): Promise<boolean> {
	const card = session.card;
	const forge = session.forge;
	if (session.accountBlock !== undefined) return false;
	if (card.kind !== "change" || card.step.advance === undefined || card.state.readOnly || !forge || !session.pack.ok) return false;
	try {
		const r = await advancePhase(forge, card.state.issue.number, card.step.advance, session.pack.pack, { merged: card.state.pr?.merged === true });
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

/** What `reconnect` needs from session start: the deps and the UI that may ask the question. */
export type SessionLink = { deps: SessionDeps; ui: AccountUI };

/** Detection reads through the account seam, so target, resolution and adapter see one environment. */
function detectDepsOf(env: AccountEnv): Partial<DetectDeps> {
	return { exec: env.exec, fetch: env.fetch, env: env.env, teaLookup: env.teaLookup };
}

/** Clears the previous connection and account state, so a reconnect starts from nothing. */
function resetConnection(session: Session): void {
	session.forge = undefined;
	session.comments = undefined;
	session.forgeError = undefined;
	session.target = undefined;
	session.account = undefined;
	session.accountBlock = undefined;
	session.accountNotice = undefined;
}

/** Target, account, adapter, identity: each step records its own failure; the forge stays usable for reads. */
async function connectForge(session: Session, link: SessionLink, chosen?: ResolvedAccount): Promise<void> {
	resetConnection(session);
	const target = await targetFor(session, link.deps);
	if (!target) return;
	const resolved = chosen ? adoptAccount(session, chosen) : await resolveSessionAccount(session, target, link);
	const connection = await connectWithAccount(session, target, resolved, link.deps);
	if (!connection) return;
	// Identity first: the forge is published only afterwards, so no write can run with an unconfirmed account.
	await confirmIdentity(session, connection.forge, resolved);
	session.forge = connection.forge;
	session.comments = connection.comments;
}

async function targetFor(session: Session, d: SessionDeps): Promise<ForgeTarget | undefined> {
	try {
		session.target = await resolveForgeTarget(session.cwd, detectDepsOf(d.accounts));
		return session.target;
	} catch (error) {
		session.forgeError = session.record("forge", error);
		return undefined;
	}
}

/** Runs the selection; a refusal becomes the block. `resolveAccount` never rejects, but a bug must not reach pi. */
async function resolveSessionAccount(session: Session, target: ForgeTarget, link: SessionLink): Promise<ResolvedAccount | undefined> {
	try {
		return adoptAccount(session, withReadOnlyLogin(target, await resolveAccount(target, session.cwd, link.ui, link.deps.accounts)));
	} catch (error) {
		session.record("account", error);
		session.accountBlock = `account selection failed: ${untrusted(messageOf(error))}`;
		return undefined;
	}
}

/**
 * A refused Gitea selection still names a `tea` login for reads, so the adapter does not fail on several
 * logins for the host; the block keeps every write refused. GitHub reads need no account.
 */
function withReadOnlyLogin(target: ForgeTarget, resolved: ResolvedAccount): ResolvedAccount {
	if (target.kind !== "gitea" || resolved.block === undefined) return resolved;
	const login = readOnlyLogin(resolved.facts);
	return login === undefined ? resolved : { ...resolved, readOnlyLogin: login };
}

function adoptAccount(session: Session, resolved: ResolvedAccount): ResolvedAccount {
	session.account = resolved;
	session.accountBlock = resolved.block;
	session.accountNotice = resolved.notice;
	return resolved;
}

/**
 * The account handed to detection: the chosen candidate, or for GitHub the environment token (passed
 * explicitly, so the adapter uses the token the selection saw; the name is only read by Gitea). A Gitea
 * environment token reaches the adapter through `env.GITEA_TOKEN`; a refused Gitea selection reads with
 * its read-only login.
 */
function detectAccount(target: ForgeTarget, resolved: ResolvedAccount | undefined): DetectDeps["account"] {
	if (resolved?.account !== undefined) return { name: resolved.account, token: resolved.token };
	if (resolved?.readOnlyLogin !== undefined) return { name: resolved.readOnlyLogin };
	if (resolved?.source === "env" && target.kind === "github") return { name: envTokenVar(target), token: resolved.token };
	return undefined;
}

type Connection = { forge: CachedForge; comments: CommentsCache };

/**
 * Builds the adapter once with the account, wrapped `RedactingForge` → `CachedForge`; not yet published
 * on the session. Errors, here and from the adapter, are redacted with every token it can send.
 */
async function connectWithAccount(
	session: Session,
	target: ForgeTarget,
	resolved: ResolvedAccount | undefined,
	d: SessionDeps,
): Promise<Connection | undefined> {
	let tokens = knownTokens(target, resolved, d);
	session.setRedactionTokens(tokens);
	try {
		tokens = await redactionTokens(target, resolved, d);
		session.setRedactionTokens(tokens);
		const account = detectAccount(target, resolved);
		const inner = await d.detect(session.cwd, { ...detectDepsOf(d.accounts), ...(account ? { account } : {}) });
		const { host, owner, repo } = target;
		const cacheRoot = join(d.home, ".pi", "agent", "livespec", "cache");
		return {
			forge: new CachedForge(new RedactingForge(inner, () => tokens), { cacheRoot, host, owner, repo }),
			comments: new CommentsCache({ dir: join(cacheRoot, host, owner, repo), now: () => d.now().getTime() }),
		};
	} catch (error) {
		session.forgeError = session.record("forge", redactTokens(messageOf(error), tokens));
		return undefined;
	}
}

/** The tokens known without a lookup: the chosen account's and the forge's environment token, whatever the resolution decided. */
function knownTokens(target: ForgeTarget, resolved: ResolvedAccount | undefined, d: SessionDeps): string[] {
	return [resolved?.token, d.accounts.env[envTokenVar(target)]].filter((t): t is string => t !== undefined && t !== "");
}

/**
 * Every token the adapter can send: the chosen account's; the forge's environment token, which the
 * adapter may send whatever the resolution decided (even when it failed); and for a refused Gitea
 * selection the read-only login's, which the adapter reads from the `tea` config itself. Read here
 * only to redact; neither is stored on the session nor rendered.
 */
async function redactionTokens(target: ForgeTarget, resolved: ResolvedAccount | undefined, d: SessionDeps): Promise<string[]> {
	const login = resolved?.readOnlyLogin;
	const readOnly = login === undefined ? undefined : await candidateToken(d.accounts, target, login);
	return readOnly === undefined ? knownTokens(target, resolved, d) : [...knownTokens(target, resolved, d), readOnly];
}

/**
 * `whoami` must equal the chosen candidate's user; for the environment token, or a candidate whose
 * user is unknown (a `tea` login without `user`), a successful `whoami` is the identity and is
 * recorded. A mismatch or a failure sets the block. Without an account (refused) nothing runs.
 */
async function confirmIdentity(session: Session, forge: CachedForge, resolved: ResolvedAccount | undefined): Promise<void> {
	if (!resolved || resolved.block !== undefined) return;
	try {
		const { login } = await forge.whoami();
		if (resolved.source === "env" || resolved.user === "") {
			session.account = { ...resolved, user: login };
			return;
		}
		if (login !== resolved.user) session.accountBlock = mismatchMessage(resolved, login);
	} catch (error) {
		session.record("account", error);
		session.accountBlock = identityFailure(session, resolved, error);
	}
}

function mismatchMessage(resolved: ResolvedAccount, login: string): string {
	return `the forge identifies the account ${resolved.account} as ${untrusted(login)}, but it was chosen as ${resolved.user}; writes are refused. Fix the login, then run ${SWITCH_COMMAND}.`;
}

function identityFailure(session: Session, resolved: ResolvedAccount, error: unknown): string {
	const reason = untrusted(messageOf(error));
	if (resolved.source === "env" && session.target) {
		const variable = envTokenVar(session.target);
		const rejected = error instanceof ForgeError && error.code === "auth";
		const what = rejected ? "was rejected by the forge" : "could not be confirmed";
		return `the environment token in ${variable} ${what} (${reason}); writes are refused until ${variable} holds a valid token.`;
	}
	return `the identity of ${resolved.account} could not be confirmed (${reason}); writes are refused until it is confirmed: start a new session or run ${SWITCH_COMMAND}.`;
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

/** The question channel of `ctx.ui`; only offered when pi has an interactive UI. */
function accountUI(ctx: ExtensionContext): AccountUI {
	return { hasUI: ctx.hasUI, select: (title, options) => ctx.ui.select(title, options) };
}

/** One notice for an uninitialized project; nothing runs and no file changes. */
async function suggestInit(session: Session, ctx: ExtensionContext): Promise<void> {
	const hasOpenSpec = await stat(join(session.cwd, OPENSPEC_DIR)).then(
		(s) => s.isDirectory(),
		() => false,
	);
	safeNotify(ctx, hasOpenSpec ? MIGRATE_HINT : INIT_HINT, "info");
}

/**
 * pi caches the extension factory per cwd, so an in-process child can share this module with its parent.
 * A child therefore never replaces an existing session. Only when none exists (a fresh module) does it store
 * one with the forge target alone, which the guard's endpoint list needs. It never connects the forge
 * (`reconnect` can advance the change), selects an account, polls approvals or shows the resume card.
 */
async function startChild(d: SessionDeps, ctx: ExtensionContext): Promise<void> {
	if (getSession() !== undefined) return;
	const session = new Session(ctx.cwd, createGit(ctx.cwd));
	await loadSessionBasics(session, d, d.content(d.home));
	if (session.initialized) await targetFor(session, d);
	if (getSession() === undefined) setSession(session);
}

async function startSession(pi: ExtensionAPI, d: SessionDeps, ctx: ExtensionContext): Promise<void> {
	const session = new Session(ctx.cwd, createGit(ctx.cwd));
	setSession(session);
	const content = d.content(d.home);
	await loadSessionBasics(session, d, content);
	if (!session.initialized) return suggestInit(session, ctx);
	session.bind({ deps: d, ui: accountUI(ctx) });
	await session.reconnect();
	await pollApprovals(session);
	await pollFeedback(session);
	if (session.accountNotice) safeNotify(ctx, session.accountNotice, "info");
	showResumeCard(pi, session);
	kickOffUpgrade(session, content, ctx);
}

/** Kills running `Verify` processes, then waits until their temporary worktrees are removed. Never throws. */
async function shutdownEvidence(): Promise<void> {
	const session = getSession();
	// Clearing is best effort: a failing listener must not keep the runs from being aborted and drained.
	try {
		clearGateMemo();
	} catch (error) {
		session?.record("shutdown", error);
	}
	if (!session) return;
	try {
		session.abortEvidence();
		await session.drainEvidence();
	} catch (error) {
		session.record("shutdown", error);
	}
}

export function registerSessionHooks(pi: ExtensionAPI, d: Partial<SessionDeps> = {}): void {
	const deps: SessionDeps = { ...defaultSessionDeps(), ...d };
	registerResumeRenderer(pi);
	// The gate memo, the evidence locks and the session are the parent's; a child's start and shutdown leave them alone.
	pi.on("session_shutdown", async (_event, ctx) => {
		if (!isChildSession(ctx)) await shutdownEvidence();
	});
	pi.on("session_start", async (_event, ctx) => {
		try {
			if (isChildSession(ctx)) return await startChild(deps, ctx);
			clearGateMemo();
			await startSession(pi, deps, ctx);
		} catch (error) {
			safeNotify(ctx, `livespec could not start: ${messageOf(error)}`, "warning");
		}
	});
}
