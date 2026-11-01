/**
 * pi-gitlab — GitLab MR/issue workflows where the file is the interface.
 *
 *   gitlab_fetch(url)  → writes/merges <slug>.gitlab.md (+ .diff, .store/)
 *   [agent edits the file: staged drafts, resolved flips, description edits]
 *   gitlab_put(path, mode)  → dry-run / review-gated submit of staged changes
 *   gitlab_watch(url, action) → fetch-on-a-timer + session-message notification
 *
 * Staged activation (plan §2): gitlab_fetch is always on; the other two
 * unlock on first successful fetch (or when persisted watches re-arm).
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { GATED_TOOLS, restrictedToolSet, unlockedToolSet } from "./activation.ts";
import {
	effectiveBypassPatterns,
	loadAuth,
	loadConfig,
	noAuthError,
	saveAuth,
	type PluginConfig,
} from "./auth.ts";
import { GitLabClient, GitLabError } from "./client.ts";
import { applySnapshot, buildSnapshot, readState } from "./fetch.ts";
import { requireLock } from "./lock.ts";
import { FormatError, findConflictMarkers, parseDocument } from "./format.ts";
import { dataRoot, statePath } from "./paths.ts";
import {
	annotateFailuresInFile,
	reconcileAfterSubmit,
	computeActions,
	describeAction,
	executeActions,
	staleBaselineIssue,
	type Action,
	type PutMode,
} from "./put.ts";
import { labelFor, parseGitLabUrl, type GitLabItemRef } from "./url.ts";
import {
	captureSeen,
	classifyChanges,
	describeWatchHealth,
	formatWatchNotice,
	reconstructWatches,
	WATCH_ENTRY_TYPE,
	watchLabel,
	watchStatusText,
	type SeenState,
	type SuppressReason,
	type WatchEntry,
	type WatchSpec,
} from "./watch.ts";

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));

const Enum = (values: string[], description?: string) =>
	Type.Unsafe<string>({ type: "string", enum: values, ...(description ? { description } : {}) });

const ok = (text: string, details: unknown = {}): AgentToolResult<unknown> => ({
	content: [{ type: "text", text }],
	details,
});
function fail(text: string): never {
	throw new Error(text);
}

function errText(e: unknown): string {
	if (e instanceof GitLabError) return e.hint ? `${e.message}\n${e.hint}` : e.message;
	return e instanceof Error ? e.message : String(e);
}

export default function piGitlab(pi: ExtensionAPI): void {
	const root = dataRoot();

	// ── config / client plumbing ──────────────────────────────────────
	const usernameCache = new Map<string, string>();

	async function clientFor(baseUrl: string): Promise<{ client: GitLabClient; cfg: PluginConfig; username: string }> {
		const [cfg, auth] = await Promise.all([loadConfig(root), loadAuth(baseUrl, root)]);
		if (!auth) fail(noAuthError(baseUrl));
		const client = new GitLabClient(baseUrl, auth.token);
		let username = auth.username ?? usernameCache.get(baseUrl);
		if (!username) {
			const u = await client.getCurrentUser();
			username = u.username;
			usernameCache.set(baseUrl, username);
			await saveAuth(baseUrl, { token: auth.token, username }, root).catch(() => {});
		}
		if (auth.username) usernameCache.set(baseUrl, auth.username);
		return { client, cfg, username: username ?? "" };
	}

	// ── shared fetch flow (fetch tool, watch start, watch tick) ───────
	async function fetchFlow(ref: GitLabItemRef) {
		const { client, cfg, username } = await clientFor(ref.baseUrl);
		const release = await requireLock(ref, { system: "pi", label: "fetch" });
		try {
			const snapshot = await buildSnapshot(ref, client);
			const res = await applySnapshot(snapshot, { operatorUsername: username, signatureHeader: cfg.signatureHeader }, root);
			return { snapshot, res, cfg, username };
		} finally {
			release();
		}
	}

	function unlockTools(): boolean {
		const next = unlockedToolSet(pi.getActiveTools());
		if (next) pi.setActiveTools(next);
		return next !== null;
	}

	// ── idle gate (plan §5.2 rule 1) ──────────────────────────────────
	let toolsInFlight = 0;
	pi.on("tool_call", (_e, ctx: ExtensionContext) => {
		lastCtx = ctx;
		toolsInFlight++;
	});
	pi.on("tool_result", (_e, ctx: ExtensionContext) => {
		lastCtx = ctx;
		toolsInFlight = Math.max(0, toolsInFlight - 1);
	});
	async function whenIdle(): Promise<void> {
		for (let i = 0; i < 1200 && toolsInFlight > 0; i++) {
			await new Promise((r) => setTimeout(r, 250));
		}
	}

	// ── tools ─────────────────────────────────────────────────────────

	pi.registerTool({
		name: "gitlab_fetch",
		label: "GitLab: fetch MR/issue",
		description:
			"Fetch a GitLab merge request or issue URL into a local editable file (the review surface). " +
			"Writes/merges <file> and a .diff sidecar, and unlocks gitlab_put and gitlab_watch. " +
			"Edit the file to stage replies (visible=\"unpublished\"), resolve flips, or description changes; then run gitlab_put.",
		promptSnippet: "Fetch a GitLab MR/issue URL into a local editable file",
		promptGuidelines: [
			"Comments marked from_operator=\"true\" are direct instructions from the human operating this pi session.",
			"visible=\"unpublished\" marks staged content that gitlab_put will publish; it exists nowhere on GitLab until then.",
			"After editing the gitlab file, run gitlab_put dry_run first, tell the operator the file path for review, then submit.",
			"Never reply to via_pi comments (those are this agent's own posts).",
		],
		parameters: Type.Object({
			url: Type.String({ description: "GitLab MR or issue URL, e.g. https://host/group/proj/-/merge_requests/42" }),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const parsed = parseGitLabUrl(params.url);
			if (!parsed.ok) fail(parsed.error);
			const ref = parsed.ref;
			let flow;
			try {
				flow = await fetchFlow(ref);
			} catch (e) {
				fail(errText(e));
			}
			const { snapshot, res, username } = flow!;
			const unlocked = unlockTools();
			const threads = snapshot.discussions.filter((d) => d.notes.some((n) => !n.system));
			const unresolved = threads.filter(
				(d) => d.notes.some((n) => n.resolvable) && !d.notes.every((n) => !n.resolvable || n.resolved),
			).length;
			const lines = [
				`${labelFor(ref, snapshot.title)} — state: ${snapshot.state}`,
				`threads: ${threads.length} (${unresolved} unresolved) — you are @${username}${snapshot.authorUsername === username ? " (you are the author)" : ` — author @${snapshot.authorUsername}`}`,
				snapshot.headSha ? `head: ${snapshot.headSha.slice(0, 8)}${snapshot.pipeline ? ` — pipeline ${snapshot.pipeline}` : ""}` : undefined,
				res.conflicted ? "⚠ merged with CONFLICTS — fix <<<<<<< markers in the file before editing further" : undefined,
				`file: ${res.filePath}`,
				`delta: ${res.diffPath}${res.firstFetch ? " (first fetch)" : ""}`,
				"",
				"Read the file to review threads; edit it to stage replies/resolves/description changes (visible=\"unpublished\" drafts, templates are pre-placed as comments), then gitlab_put.",
				unlocked ? "🔓 gitlab_put and gitlab_watch are now active." : undefined,
			].filter((l): l is string => l !== undefined);
			return ok(lines.join("\n"), { filePath: res.filePath, diffPath: res.diffPath, conflicted: res.conflicted });
		},
	});

	pi.registerTool({
		name: "gitlab_put",
		label: "GitLab: put staged changes",
		description:
			"Compute and publish the staged changes in a gitlab item file (draft comments, resolve flips, description edits). " +
			"mode=dry_run lists actions + validation; submit asks the operator once (only when confirmBeforePost=true; when false it posts directly). " +
			"submit_bypass_user_review posts with no dialog and is always available — use it ONLY when the user explicitly said to submit without their review.",
		promptSnippet: "Publish staged changes in a gitlab file",
		executionMode: "sequential",
		parameters: Type.Object({
			path: Type.String({ description: "Path to the .gitlab.md file (from gitlab_fetch)" }),
			mode: Enum(["dry_run", "submit", "submit_bypass_user_review"], "dry_run | submit | submit_bypass_user_review"),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const mode = params.mode as PutMode;
			const filePath = path.resolve(params.path);
			const raw = await readText(filePath);
			// marker guard BEFORE parse: a conflicted file fails parsing, and the
			// agent needs the §7 instruction (repair markers), not a parse error
			const markers = findConflictMarkers(raw);
			if (markers.length)
				fail(`line ${markers[0].line}: unresolved merge conflict marker "${markers[0].marker}" — resolve conflicts in the file first, then resubmit`);
			let doc;
			try {
				doc = parseDocument(raw);
			} catch (e) {
				if (e instanceof FormatError) fail(`cannot parse ${filePath}:\n${e.message}\nFix the file (errors cite line numbers), then re-run dry_run.`);
				throw e;
			}
			const parsed = parseGitLabUrl(doc!.root.source);
			if (!parsed.ok) fail(`file ${filePath}: ${parsed.error}`);
			const ref = parsed.ref;

			let client: GitLabClient, cfg: PluginConfig, username: string;
			try {
				({ client, cfg, username } = await clientFor(ref.baseUrl));
			} catch (e) {
				fail(errText(e));
			}
			let snapshot;
			try {
				snapshot = await buildSnapshot(ref, client!);
			} catch (e) {
				fail(errText(e));
			}

			const bypass = effectiveBypassPatterns(cfg!, ref.baseUrl);
			const { actions, errors, warnings } = computeActions(doc!, snapshot!, username!, raw, bypass);
			const stale = staleBaselineIssue(doc!, snapshot!, mode);

			const report = (acts: Action[], errs: string[], warns: string[]) => {
				const out: string[] = [];
				out.push(acts.length ? acts.map((a, i) => describeAction(a, i)).join("\n") : "(no changes staged)");
				if (warns.length) out.push("", ...warns.map((w) => `⚠ ${w}`));
				if (errs.length) out.push("", ...errs.map((er) => `✗ ${er}`));
				return out.join("\n");
			};
			const warnLines = warnings.map((w) => w.message).concat(stale?.level === "warning" ? [stale.message] : []);
			const errorLines = errors.map((e) => e.message).concat(stale?.level === "error" ? [stale.message] : []);

			if (mode === "dry_run") {
				return ok(`dry run — planned actions:\n${report(actions, errorLines, warnLines)}`, { actionCount: actions.length });
			}

			if (errorLines.length) {
				fail(`validation failed:\n${report([], errorLines, warnLines)}`);
			}
			if (!actions.length) {
				return ok("nothing staged — the file matches the server.", {});
			}

			// mode === "submit_bypass_user_review": always available, posts with no dialog.
			// (The agent's instructions: use bypass ONLY on an explicit operator request.)
			// mode === "submit": gates on the operator's review dialog iff confirmBeforePost=true.
			if (mode === "submit" && cfg!.confirmBeforePost && !ctx.hasUI) {
				fail("submit needs the interactive review dialog (confirmBeforePost=true) but this session has no UI. Run in TUI, or the operator may explicitly ask for submit_bypass_user_review.");
			}
			if (mode === "submit" && cfg!.confirmBeforePost) {
				const preview = actions
					.map((a, i) => describeAction(a, i))
					.join("\n");
				const approved = await ctx.ui.confirm(
					`gitlab_put ${labelFor(ref)} — ${actions.length} action${actions.length > 1 ? "s" : ""}`,
					`File: ${filePath}\n\n${preview}\n\nBodies post with the agent signature header unless flagged unsigned in the preview. Submit all?`,
				);
				if (!approved) {
					return ok("cancelled by operator — do not resubmit unless asked.", { cancelled: true });
				}
			}

			let putRelease: () => void;
			try {
				putRelease = await requireLock(ref, { system: "pi", label: "put" });
			} catch (e) {
				fail(errText(e));
				return ok("", {}); // unreachable
			}
			try {
			// execute (sequential, paced) + post-submit re-render (plan §5 invariant)
			const diffRefs = snapshot!.diffRefs ?? (await readStateDiffRefs(ref));
			const outcomes = await executeActions(client!, ref, actions, {
				signatureHeader: cfg!.signatureHeader,
				operatorUsername: username!,
				diffRefs: diffRefs ?? undefined,
			});
			const failed = outcomes.filter((o) => !o.ok);
			// strip just-posted drafts / sync edited bodies before the merge
			// re-render, or the 3-way merge re-applies them and the next put
			// would post them again (double-post)
			await reconcileAfterSubmit(filePath, outcomes);
			const post = await buildSnapshot(ref, client!);
			// silence self-noise: a running watch on this item must not
			// classify the description/resolve changes we just posted
			const running = pollers.get(ref.url);
			if (running) running.seen = captureSeen(post);
			const postedIds = outcomes.map((o) => o.postedNoteId).filter((n): n is number => n !== undefined);
			const applied = await applySnapshot(
				post,
				{ operatorUsername: username!, signatureHeader: cfg!.signatureHeader },
				root,
				undefined,
				postedIds,
			);
			await annotateFailuresInFile(
				applied.filePath,
				failed.map((f) => ({
					body: "body" in f.action ? String(f.action.body) : "",
					error: f.error ?? "unknown error",
				})),
			);

			const lines = outcomes.map((o, i) => {
				const mark = o.ok ? "✓" : o.notAttempted ? "⊘ not attempted" : "✗";
				return `${mark} ${describeAction(o.action, i)}${o.error ? ` — ${o.error}` : ""}`;
			});
			const succeeded = outcomes.length - failed.length;
			return ok(
				`${succeeded} posted, ${failed.length} failed.\n${lines.join("\n")}\nfile: ${applied.filePath}${failed.length ? "\nFailed drafts remain staged with a <!-- put FAIL … --> marker; fix and resubmit." : ""}`,
				{ succeeded: succeeded, failed: failed.length },
			);
			} finally {
				putRelease();
			}
		},
	});

	// ── watch runtime ─────────────────────────────────────────────────
	interface Poller {
		spec: WatchSpec;
		ref: GitLabItemRef;
		timer: NodeJS.Timeout;
		seen: SeenState;
		inTick: boolean;
		release?: () => void;
		failCount: number;
		lastFailNotify: number;
		/** in-memory activity record (bounded): powers the list query. */
		lastTickAt: number;
		lastError: string | null;
		suppressedSinceArm: Partial<Record<SuppressReason, number>>;
		notifiedCount: number;
	}
	const pollers = new Map<string, Poller>();

	/** Footer status segment ("gitlab: watching N items") so an idle agent
	 * with active watches is visibly not doing nothing. */
	function refreshWatchStatus(): void {
		if (!lastCtx?.hasUI) return;
		const labels = [...pollers.values()].map((p) => watchLabel(p.ref)).sort();
		lastCtx.ui.setStatus("pi-gitlab", watchStatusText(labels));
	}
	// most recent live context (watch ticks have no ctx of their own)
	let lastCtx: ExtensionContext | null = null;

	async function tick(p: Poller): Promise<void> {
		if (p.inTick) return;
		p.inTick = true;
		try {
			const { client, cfg, username } = await clientFor(p.ref.baseUrl);
			const snapshot = await buildSnapshot(p.ref, client);
			const st = await readState(p.ref, root);
			const { notice, suppressed } = classifyChanges(p.seen, snapshot, username, cfg.signatureHeader, {
				viaPiNoteIds: new Set(st?.viaPiNoteIds ?? []),
				bypass: effectiveBypassPatterns(cfg, p.ref.baseUrl),
			});
			p.seen = captureSeen(snapshot);
			p.lastTickAt = Date.now();
			p.lastError = null;
			for (const s of suppressed) p.suppressedSinceArm[s.reason] = (p.suppressedSinceArm[s.reason] ?? 0) + 1;
			if (notice) p.notifiedCount++;
			p.failCount = 0; // healthy tick — reset the failure-tracking below
			// §5.2: queue the file mutation until the agent is idle
			await whenIdle();
			const res = await applySnapshot(snapshot, { operatorUsername: username, signatureHeader: cfg.signatureHeader }, root);
			if (notice) {
				const text = formatWatchNotice(labelFor(p.ref, snapshot.title), notice, res.filePath, res.conflicted);
				// Always steer. While streaming it injects into the running turn
				// so the agent sees the MR change ASAP; when idle pi ignores
				// deliverAs and the same send starts a fresh turn. The streaming
				// check lives inside prompt(), so there is no idle/stream race.
				// Never followUp — it only queues behind the current turn.
				pi.sendUserMessage(text, { deliverAs: "steer" });
				if (notice.terminal) await stopWatch(p.ref.url, `item ${notice.terminalReason ?? notice.terminal}`);
			}
		} catch (e) {
			// A persistent failure (revoked token, network down) must not look
			// like a healthy silent watch. Transient blips stay quiet; after 3
			// consecutive failed ticks steer the agent once, then at most hourly.
			p.lastError = errText(e);
			p.failCount++;
			const now = Date.now();
			if (p.failCount === 3 || (p.failCount > 3 && now - p.lastFailNotify > 3_600_000)) {
				p.lastFailNotify = now;
				pi.sendUserMessage(
					`[gitlab watch] ${labelFor(p.ref)}: polling is failing (attempt ${p.failCount}, last error: ${errText(e)}) — the watch is still running and will keep retrying. If the token was rejected, ask the operator to re-run /gitlab-auth.`,
					{ deliverAs: "steer" },
				);
			}
		} finally {
			p.inTick = false;
		}
	}

	function registerPoller(spec: WatchSpec, seen: SeenState): void {
		const ref = parseGitLabUrl(spec.url);
		if (!ref.ok) return;
		const key = ref.ref.url;
		const old = pollers.get(key);
		if (old) { clearInterval(old.timer); old.release?.(); }
		const timer = setInterval(() => void tick(poller), spec.intervalSeconds * 1000);
		timer.unref();
		const poller: Poller = { spec, ref: ref.ref, timer, seen, inTick: false, release: pendingWatchRelease, failCount: 0, lastFailNotify: 0, lastTickAt: 0, lastError: null, suppressedSinceArm: {}, notifiedCount: 0 };
		pendingWatchRelease = undefined;
		pollers.set(key, poller);
		refreshWatchStatus();
	}
	// hand-off slot: startWatch acquires the watch lock before registerPoller
	// (registerPoller is re-entrant-safe: replacing a poller releases its lock)
	let pendingWatchRelease: (() => void) | undefined = undefined;

	async function startWatch(
		params: { url: string; intervalSeconds?: number },
		fromResume: boolean,
	): Promise<string> {
		const parsed = parseGitLabUrl(params.url);
		if (!parsed.ok) fail(parsed.error);
		const cfg = await loadConfig(root);
		const intervalSeconds = Math.max(30, Math.floor(params.intervalSeconds ?? cfg.watchIntervalSeconds));
		const { snapshot } = await fetchFlow(parsed.ref); // initial fetch baselines the file
		pendingWatchRelease = await requireLock(parsed.ref, { system: "pi", label: "watch" });
		const spec: WatchSpec = { url: parsed.ref.url, intervalSeconds, startedAt: new Date().toISOString() };
		registerPoller(spec, captureSeen(snapshot));
		if (!fromResume) {
			pi.appendEntry<WatchEntry>(WATCH_ENTRY_TYPE, { action: "start", ...spec });
		}
		return `${labelFor(parsed.ref, snapshot.title)} every ${intervalSeconds}s${fromResume ? " (re-armed)" : ""}`;
	}

	async function stopWatch(url: string, reason?: string): Promise<string> {
		const parsed = parseGitLabUrl(url);
		const key = parsed.ok ? parsed.ref.url : url;
		const p = pollers.get(key);
		if (p) {
			clearInterval(p.timer);
			pollers.delete(key);
			p.release?.();
		}
		refreshWatchStatus();
		pi.appendEntry<WatchEntry>(WATCH_ENTRY_TYPE, { action: "stop", url: key, intervalSeconds: 0 });
		return `stopped watch on ${key}${reason ? ` (${reason})` : ""}`;
	}

	pi.registerTool({
		name: "gitlab_watch",
		label: "GitLab: watch MR/issue",
		description:
			"Start/stop/list background watches on GitLab MRs or issues. On change, the plugin merges the item file (preserving staged edits) and notifies you with a one-line summary plus the file/diff paths.",
		promptSnippet: "Watch a GitLab MR or issue for changes",
		parameters: Type.Object({
			url: Type.Optional(
				Type.String({ description: "GitLab MR or issue URL. Required for start/stop; ignored (may be omitted) for list." }),
			),
			action: Enum(["start", "stop", "list"], "start | stop | list"),
			intervalSeconds: Type.Optional(Type.Number({ description: "Poll interval (default from config, min 30)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const action = params.action as "start" | "stop" | "list";
			const url = params.url?.trim();
			if (action !== "list" && !url) fail("gitlab_watch: 'url' is required for start/stop (list needs none).");
			if (action === "list") {
				if (!pollers.size) return ok("no active watches.", {});
				const lines = [...pollers.values()].map(
					(p) =>
						`${labelFor(p.ref)} — every ${p.spec.intervalSeconds}s${p.spec.startedAt ? ` since ${p.spec.startedAt}` : ""}: ${describeWatchHealth(p)}`,
				);
				return ok(`active watches:\n${lines.join("\n")}`, {});
			}
			if (action === "stop") {
				const key = (() => { const r = parseGitLabUrl(url!); return r.ok ? r.ref.url : url!; })();
				if (!pollers.has(key)) return ok(`no active watch on ${key}.`, {});
				return ok(await stopWatch(url!), {});
			}
			try {
				const msg = await startWatch({ url: url!, intervalSeconds: params.intervalSeconds }, false);
				unlockTools();
				return ok(`watching ${msg}\nYou'll get a message when something changes; the file stays merged with your staged edits.`, {});
			} catch (e) {
				fail(errText(e));
				return ok("", {}); // unreachable
			}
		},
	});

	// ── /gitlab-auth (the only command; plan §3) ──────────────────────
	pi.registerCommand("gitlab-auth", {
		description: "Store a GitLab Personal Access Token for an instance: /gitlab-auth [base-url]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const baseUrl = (args.trim() || "https://gitlab.com").replace(/\/+$/, "");
			if (!/^https?:\/\/[^/]+$/.test(baseUrl)) {
				ctx.ui.notify(`usage: /gitlab-auth [base-url] — e.g. https://gitlab.example.com (no path)`, "error");
				return;
			}
			if (baseUrl.startsWith("http://") && !/^http:\/\/(localhost|127\.|::1)/.test(baseUrl)) {
				ctx.ui.notify("http:// is only allowed for loopback hosts.", "error");
				return;
			}
			ctx.ui.notify(
				`Mint a Personal Access Token with the "api" scope at ${baseUrl}/-/user_settings/personal_access_tokens (older GitLab: ${baseUrl}/-/profile/personal_access_tokens), then paste it here.`,
				"info",
			);
			const token = (await ctx.ui.input(`GitLab token for ${baseUrl}`, "glpat-…"))?.trim();
			if (!token) {
				ctx.ui.notify("gitlab-auth cancelled (no token given).", "info");
				return;
			}
			const client = new GitLabClient(baseUrl, token);
			try {
				const user = await client.getCurrentUser();
				await saveAuth(baseUrl, { token, username: user.username }, root);
				ctx.ui.notify(`stored token for ${baseUrl} — will post as @${user.username}.`, "info");
				usernameCache.set(baseUrl, user.username);
			} catch (e) {
				const err = e as GitLabError;
				if (err.status === 401 || err.status === 403) {
					ctx.ui.notify(`token rejected (${err.status}) — not stored. Check the token and its "api" scope.`, "error");
				} else {
					// off-VPN case (plan §3): warn but store
					await saveAuth(baseUrl, { token }, root);
					ctx.ui.notify(`couldn't reach ${baseUrl} (${err.message}) — token stored anyway; it will be verified on first use.`, "warning");
				}
			}
		},
	});

	// ── events ────────────────────────────────────────────────────────
	pi.on("resources_discover", () => ({
		skillPaths: [path.join(EXT_DIR, "skills", "gitlab-mr-review")],
	}));

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		lastCtx = ctx;
		// staged activation: restrict to base + gitlab_fetch (plan §2)
		const current = pi.getActiveTools();
		if (GATED_TOOLS.some((g) => current.includes(g))) {
			pi.setActiveTools(restrictedToolSet(current));
		}
		// re-arm persisted watches (stop-over-start tombstones)
		const entries = ctx.sessionManager
			.getEntries()
			.filter((e) => e.type === "custom" && e.customType === WATCH_ENTRY_TYPE)
			.map((e) => (e as { data?: WatchEntry }).data!)
			.filter((d): d is WatchEntry => !!d && typeof d.url === "string");
		const specs = reconstructWatches(entries);
		for (const spec of specs.values()) {
			try {
				await startWatch(spec, true);
			} catch {
				// offline or token gone — the watch re-registers on next successful start
			}
		}
		if (specs.size) unlockTools();
	});
}

async function readText(file: string): Promise<string> {
	const fs = await import("node:fs/promises");
	return fs.readFile(file, "utf8");
}

async function readStateDiffRefs(ref: GitLabItemRef) {
	try {
		const fs = await import("node:fs/promises");
		const s = JSON.parse(await fs.readFile(statePath(ref, dataRoot()), "utf8"));
		return s.diffRefs ?? null;
	} catch {
		return null;
	}
}
