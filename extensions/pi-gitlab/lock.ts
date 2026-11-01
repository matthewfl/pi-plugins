/**
 * Per-item advisory lock (plan §11 CLI round): a pi extension session and
 * non-pi agents (the pi-gitlab CLI) must not mutate/fetch/watch the same
 * MR/issue at the same time. One lock file per item in the shared store dir.
 *
 * Protocol: O_EXCL create; JSON holder info; reclaim when the holder's pid
 * is dead (same host) or a non-watch holder is older than OP_STALE_MS
 * (one-shot fetch/put taking >30m is crash residue; watches legitimately
 * live for hours and are only reclaimed on death or unreadability).
 * Advisory: both cooperation parties must honor it (extension + CLI).
 * Pure module.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { storeDir } from "./paths.ts";
import type { GitLabItemRef } from "./url.ts";

export type LockSystem = "pi" | "cli";
export type LockLabel = "fetch" | "put" | "watch";

export interface LockInfo {
	pid: number;
	host: string;
	system: LockSystem;
	label: LockLabel;
	since: string; // ISO
}

export type LockOutcome =
	| { ok: true; release(): void }
	| { ok: false; holder: LockInfo | "unknown"; reason: string };

const LOCK_NAME = "pi-gitlab.lock";
const OP_STALE_MS = 30 * 60_000; // one-shot holders older than this are crash residue

export function lockPath(ref: GitLabItemRef, root?: string): string {
	return path.join(storeDir(ref, root), LOCK_NAME);
}

function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// EPERM = exists but not ours → alive; ESRCH/EINVAL → gone
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function readLock(p: string): LockInfo | null {
	try {
		const j = JSON.parse(readFileSync(p, "utf8")) as LockInfo;
		if (Number.isInteger(j?.pid) && typeof j.system === "string") return j;
	} catch { /* absent or unreadable */ }
	return null;
}

/** non-null when the given holder may be reclaimed. */
function staleReason(holder: LockInfo | null): string | null {
	if (!holder) return "unreadable lock file";
	if (holder.host === hostname() && !pidAlive(holder.pid)) {
		return `holder ${holder.system} process (pid ${holder.pid}) is gone`;
	}
	if (holder.label !== "watch" && Date.now() - Date.parse(holder.since) > OP_STALE_MS) {
		return `stale one-shot lock (${holder.label}, >30m old)`;
	}
	return null;
}

export function describeHolder(holder: LockInfo | "unknown"): string {
	if (holder === "unknown") return "a lock file I can't read";
	const since = Number.isNaN(Date.parse(holder.since)) ? "" : ` since ${holder.since.slice(0, 19)}Z`;
	return `${holder.system === "cli" ? "a pi-gitlab CLI" : "a pi extension session"} (${holder.label}, pid ${holder.pid}${since})`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Try to acquire the item lock. waitMs > 0 polls while the lock is held
 * (dead-lock detection uses reclaim — no need to wait long otherwise).
 */
export async function acquireLock(
	ref: GitLabItemRef,
	opts: { system: LockSystem; label: LockLabel; waitMs?: number; root?: string },
): Promise<LockOutcome> {
	const p = lockPath(ref, opts.root);
	mkdirSync(path.dirname(p), { recursive: true });
	const info: LockInfo = {
		pid: process.pid,
		host: hostname(),
		system: opts.system,
		label: opts.label,
		since: new Date().toISOString(),
	};
	const deadline = Date.now() + (opts.waitMs ?? 0);
	for (;;) {
		try {
			writeFileSync(p, JSON.stringify(info) + "\n", { flag: "wx", mode: 0o600 });
			return { ok: true, release: () => releaseLock(p, info.pid) };
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
				return { ok: false, holder: "unknown", reason: errText(e) };
			}
			const holder = readLock(p) ?? ("unknown" as const);
			// The protocol excludes two SYSTEMS, not one agent from itself: a
			// process that already owns the item (e.g. a pi session watching an
			// MR and later gitlab_fetch/gitlab_put-ing it) passes through. The
			// pass-through release is a no-op so a transient op can never
			// unlink the long-lived holder's file.
			if (holder !== "unknown" && holder.host === hostname() && holder.pid === process.pid) {
				return { ok: true, release: () => {} };
			}
			const why = staleReason(holder === "unknown" ? null : holder);
			if (why) {
				try { unlinkSync(p); continue; } catch { /* someone else reclaimed */ }
			}
			if (Date.now() >= deadline) {
				return { ok: false, holder, reason: why ?? `held by ${describeHolder(holder)}` };
			}
			await sleep(250);
		}
	}
}

function releaseLock(p: string, pid: number): void {
	try {
		const holder = readLock(p);
		if (holder && holder.pid === pid) unlinkSync(p);
	} catch { /* already gone */ }
}

export class LockConflictError extends Error {
	readonly holder: LockInfo | "unknown";
	constructor(holder: LockInfo | "unknown") {
		super(`${describeHolder(holder)} is already working on this item — merge requests should have one agent at a time; try again later`);
		this.name = "LockConflictError";
		this.holder = holder;
	}
}

/** acquire-or-throw convenience for tool/cli failure paths. */
export async function requireLock(
	ref: GitLabItemRef,
	opts: { system: LockSystem; label: LockLabel; waitMs?: number; root?: string },
): Promise<() => void> {
	const out = await acquireLock(ref, opts);
	if (!out.ok) throw new LockConflictError(out.holder);
	return out.release;
}

function errText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
