/**
 * Watch state: persistence reconstruction + change classification (plan §9).
 * Pi-free — the poller runtime in index.ts injects its effects.
 */

import { fullBodyBypassMatchers } from "./auth.ts";
import type { ItemSnapshot } from "./fetch.ts";
import { parseGitLabUrl } from "./url.ts";

// ─── Persistence (appendEntry tombstones; plan §9 resume) ───────────

export const WATCH_ENTRY_TYPE = "pi-gitlab:watch";

export interface WatchSpec {
	url: string;
	intervalSeconds: number;
	startedAt?: string;
}

export interface WatchEntry extends WatchSpec {
	action: "start" | "stop";
}

/** Apply stop-over-start in order; key = canonical item url. */
export function reconstructWatches(entries: WatchEntry[]): Map<string, WatchSpec> {
	const out = new Map<string, WatchSpec>();
	for (const e of entries) {
		const parsed = parseGitLabUrl(e.url);
		if (!parsed.ok) continue;
		const key = parsed.ref.url;
		if (e.action === "stop") {
			out.delete(key);
		} else {
			out.set(key, {
				url: parsed.ref.url,
				intervalSeconds: Math.max(30, Math.floor(e.intervalSeconds || 120)),
				startedAt: e.startedAt,
			});
		}
	}
	return out;
}

// ─── Change classification (plan §9 notify rules) ────────────────────

/** Why a seen change stayed silent — attribution for quiet ticks (the
 *  on-demand answer to "is the watch working?"; silence stays silent, it
 *  just becomes inspectable via gitlab_watch list / the footer). */
export type SuppressReason =
	| "own-signed-post" // our own signature-prefixed note
	| "own-recorded-post" // our own unsigned post (state.json via_pi ids)
	| "system-note" // GitLab bookkeeping notes
	| "whitelist-body" // verbatim bot-trigger body (bypassSignaturePatterns)
	| "pipeline-progress" // non-terminal pipeline transition
	| "terminal-to-terminal"; // e.g. success → failed, both terminal

export interface SuppressedEvent {
	reason: SuppressReason;
	detail?: string;
}

/** classifyChanges result: the notice to send (if any) plus everything
 *  that was seen and deliberately kept quiet. */
export interface Classification {
	notice: WatchNotice | null;
	suppressed: SuppressedEvent[];
}

/** Minimal per-item memory between ticks. */
export interface SeenState {
	noteKeys: Set<string>; // `${discId}:${noteId}` of non-system notes
	resolvedByDisc: Map<string, boolean>;
	headSha?: string;
	pipeline?: string;
	state: string;
	/** raw description body — edits bump updated_at but carry no notes,
	 * so they must be fingerprinted here to notify ("description updated") */
	description?: string;
	/** rendered title — renames are fingerprinted like descriptions */
	title?: string;
}

const TERMINAL_PIPELINE = new Set(["success", "failed", "canceled"]);

function discussionResolved(notes: { resolvable: boolean; resolved: boolean }[]): boolean {
	const r = notes.filter((n) => n.resolvable);
	return r.length > 0 && r.every((n) => n.resolved);
}

export function captureSeen(snapshot: ItemSnapshot): SeenState {
	const noteKeys = new Set<string>();
	const resolvedByDisc = new Map<string, boolean>();
	for (const d of snapshot.discussions) {
		for (const n of d.notes) {
			if (!n.system) noteKeys.add(`${d.id}:${n.id}`);
		}
		resolvedByDisc.set(d.id, discussionResolved(d.notes));
	}
	return {
		noteKeys,
		resolvedByDisc,
		headSha: snapshot.headSha,
		pipeline: snapshot.pipeline,
		state: snapshot.state,
		description: snapshot.description,
		title: snapshot.title,
	};
}

export interface WatchNotice {
	/** compact summary line parts: "2 new notes", "1 resolve flip", … */
	parts: string[];
	/** merged/closed → final notification + auto-stop */
	terminal: boolean;
	terminalReason?: string;
	/** true when the change set contains notes (not only pipeline/state info) */
	hasNotes: boolean;
}

export interface ClassifyOptions {
	/** note ids the extension posted (state.json) — silent even without a signature */
	viaPiNoteIds?: ReadonlySet<number>;
	/** unsigned-trigger whitelist patterns: treated as our own only when the
	 * ENTIRE trimmed body matches (fullBodyBypassMatchers) — prose mentioning
	 * a trigger phrase still notifies, per the advisory narrowing. */
	bypass?: RegExp[];
}

export function classifyChanges(
	prev: SeenState,
	snapshot: ItemSnapshot,
	operatorUsername: string,
	signatureHeader: string,
	opts: ClassifyOptions = {},
): Classification {
	const parts: string[] = [];
	const suppressed: SuppressedEvent[] = [];
	let hasNotes = false;
	const fullBypass = fullBodyBypassMatchers(opts.bypass ?? []);

	// new notes (self-posts excluded via signature; operator's web notes DO notify)
	let newNotes = 0;
	const prevDiscIds = new Set(prev.resolvedByDisc.keys());
	let newThreads = 0;
	for (const d of snapshot.discussions) {
		if (!prevDiscIds.has(d.id)) newThreads++;
		for (const n of d.notes) {
			if (n.system) {
				suppressed.push({ reason: "system-note", detail: `note ${n.id}` });
				continue;
			}
			if (prev.noteKeys.has(`${d.id}:${n.id}`)) continue; // already seen — not a change
			if (n.body.startsWith(signatureHeader)) {
				suppressed.push({ reason: "own-signed-post", detail: `note ${n.id}` });
				continue;
			} // our own signed posts → silent
			if (opts.viaPiNoteIds?.has(n.id)) {
				suppressed.push({ reason: "own-recorded-post", detail: `note ${n.id}` });
				continue;
			} // our own unsigned posts (whitelist) → silent
			if (fullBypass.some((re) => re.test(n.body.trim()))) {
				suppressed.push({ reason: "whitelist-body", detail: `note ${n.id}: ${n.body.trim().slice(0, 40)}` });
				continue;
			} // verbatim trigger posts → silent
			newNotes++;
		}
	}
	if (newNotes) {
		hasNotes = true;
		parts.push(`${newNotes} new note${newNotes > 1 ? "s" : ""}${newThreads ? ` (${newThreads} new thread${newThreads > 1 ? "s" : ""})` : ""}`);
	}

	// resolve flips
	let flips = 0;
	for (const [id, resolved] of snapshot.discussions.map((d) => [d.id, discussionResolved(d.notes)] as const)) {
		const before = prev.resolvedByDisc.get(id);
		if (before !== undefined && before !== resolved) flips++;
	}
	if (flips) parts.push(`${flips} resolve flip${flips > 1 ? "s" : ""}`);

	// title renames (no notes involved — same fingerprint rationale as
	// description edits). Legacy seen without a title fingerprint adopts silently.
	if (prev.title !== undefined && prev.title.trim() !== snapshot.title.trim())
		parts.push("title updated");

	// description edits (no notes involved; trailing-newline-tolerant).
	// prev.description undefined = legacy seen from before fingerprints →
	// just adopt, don't false-fire.
	if (prev.description !== undefined && prev.description.replace(/\s+$/, "") !== snapshot.description.replace(/\s+$/, ""))
		parts.push("description updated");

	// head SHA move
	const prevSha = prev.headSha;
	if (snapshot.headSha && prevSha && snapshot.headSha !== prevSha) {
		parts.push(`head moved ${prevSha.slice(0, 7)}→${snapshot.headSha.slice(0, 7)}`);
		hasNotes = true;
	}

	// pipeline: terminal transitions only (progress stays silent)
	if (
		snapshot.pipeline &&
		snapshot.pipeline !== prev.pipeline &&
		TERMINAL_PIPELINE.has(snapshot.pipeline) &&
			!TERMINAL_PIPELINE.has(prev.pipeline ?? "")
	) {
		parts.push(`pipeline ${snapshot.pipeline}`);
	} else if (snapshot.pipeline && snapshot.pipeline !== prev.pipeline) {
		// progress (or terminal → terminal) is silent by design — attribute it
		suppressed.push({
			reason:
				TERMINAL_PIPELINE.has(snapshot.pipeline) && TERMINAL_PIPELINE.has(prev.pipeline ?? "")
					? "terminal-to-terminal"
					: "pipeline-progress",
			detail: `${prev.pipeline ?? "none"} to ${snapshot.pipeline}`,
		});
	}

	// state transitions
	let terminal = false;
	let terminalReason: string | undefined;
	if (snapshot.state !== prev.state) {
		if (snapshot.state === "merged") {
			terminal = true;
			terminalReason = "merged";
			parts.push("merged 🎉");
		} else if (snapshot.state === "closed") {
			terminal = true;
			terminalReason = "closed";
			parts.push("closed");
		} else {
			parts.push(`state ${prev.state}→${snapshot.state}`);
		}
	}

	if (!parts.length) return { notice: null, suppressed };
	return { notice: { parts, terminal, terminalReason, hasNotes }, suppressed };
}

/** The one compact line sent via session message (plan §9). */
export function formatWatchNotice(
	label: string,
	notice: WatchNotice,
	filePath: string,
	conflicted: boolean,
): string {
	const conflictNote = conflicted
		? `\n⚠ merged with conflicts — fix the <<<<<<< markers in ${filePath} before editing further.`
		: "";
	return (
		`[gitlab watch] ${label}: ${notice.parts.join(", ")}.\n` +
		`file: ${filePath} (delta: ${filePath}.diff)${conflictNote}`
	);
}

export function isTerminalState(state: string): boolean {
	return state === "merged" || state === "closed";
}

// ─── Status bar text ───────────────────────────────────────────────

/**
 * Footer/status-bar segment so an idle agent with watches active visibly
 * isn't "doing nothing". labels are compact identifiers like "!1 agents".
 * At most two labels are shown, then "+N more". undefined clears the segment.
 */
export function watchStatusText(labels: readonly string[]): string | undefined {
	if (!labels.length) return undefined;
	const shown = labels.slice(0, 2).join(", ");
	const extra = labels.length > 2 ? ` +${labels.length - 2} more` : "";
	return `gitlab: watching ${shown}${extra}`;
}

/** Compact display label for status text: "!iid leaf" or "#iid leaf". */
export function watchLabel(ref: { kind: "mr" | "issue"; iid: number; projectPath: string }): string {
	const leaf = ref.projectPath.split("/").pop() ?? ref.projectPath;
	return `${ref.kind === "mr" ? "!" : "#"}${ref.iid} ${leaf}`;
}

// ─── Attributable silence: per-watch health for the list query ──────

/** The bounded in-memory facts a poller tracks between ticks. Index.ts's
 *  Poller satisfies this structurally. */
export interface WatchHealth {
	/** epoch ms of the last completed tick (0 = never ticked) */
	lastTickAt: number;
	/** consecutive failed ticks (0 = healthy) */
	failCount: number;
	/** last tick error text (null = healthy) */
	lastError: string | null;
	/** suppression counts accumulated since the watch was (re-)armed */
	suppressedSinceArm: Partial<Record<SuppressReason, number>>;
	/** notifications delivered since the watch was (re-)armed */
	notifiedCount: number;
}

/** One line answering "is this watch working, and why was it silent?" —
 *  used by gitlab_watch list so silence is attributable on demand. */
export function describeWatchHealth(h: WatchHealth, now: number = Date.now()): string {
	if (!h.lastTickAt) return "no tick yet";
	if (h.failCount > 0)
		return `failing — ${h.failCount} consecutive tick error(s)${h.lastError ? ` (last error: ${h.lastError.slice(0, 120)})` : ""}`;
	const age = Math.max(0, Math.round((now - h.lastTickAt) / 1000));
	const supp = Object.entries(h.suppressedSinceArm).filter(([, n]) => (n ?? 0) > 0);
	const suppTxt = supp.length ? `, ${supp.map(([r, n]) => `${n} suppressed (${r})`).join(", ")}` : "";
	return `healthy — last tick ${age}s ago, ${h.notifiedCount} notified${suppTxt}`;
}
