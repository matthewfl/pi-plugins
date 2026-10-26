import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os, { hostname } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { acquireLock, describeHolder, LockConflictError, lockPath, readLock, requireLock } from "../lock.ts";
import { parseGitLabUrl } from "../url.ts";

const REF = (() => { const r = parseGitLabUrl("https://gitlab.com/g/p/-/merge_requests/3"); assert.ok(r.ok); return r.ref; })();

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "pig-lock-")); }

/** plant a lock file claiming ownership by a given pid. */
function plantLock(root: string, pid: number, label: string, since = new Date().toISOString(), system = "cli") {
	const dir = path.dirname(lockPath(REF, root));
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		lockPath(REF, root),
		JSON.stringify({ pid, host: hostname(), system, label, since }) + "\n",
	);
}

/** a LIVE pid that is not ours (stands in for another agent process). */
function otherProcess() {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
	const exited = new Promise((r) => child.once("exit", r));
	return { pid: child.pid!, kill: async () => { child.kill("SIGKILL"); await exited; } };
}

test("acquire → holder info; other-process acquire conflicts with clear description; release frees", async () => {
	const root = tmp();
	const a = await acquireLock(REF, { system: "pi", label: "fetch", root });
	assert.ok(a.ok);
	const me = readLock(lockPath(REF, root))!;
	assert.equal(me.pid, process.pid);
	assert.equal(me.system, "pi");

	const other = otherProcess();
	plantLock(root, other.pid, "put", new Date().toISOString(), "cli");
	// plantLock OVERWRITES our own lock — this is now an other-process hold:
	const b = await acquireLock(REF, { system: "pi", label: "fetch", root, waitMs: 50 });
	assert.ok(!b.ok);
	if (!b.ok) assert.match(b.reason, /pi-gitlab CLI \(put, pid \d+/);
	await other.kill();
	const grown = await acquireLock(REF, { system: "pi", label: "fetch", root });
	assert.ok(grown.ok, "dead other-process holder reclaimed after kill");
	grown.release();
	assert.ok(!fs.existsSync(lockPath(REF, root)), "released lock file removed");
	const c = await acquireLock(REF, { system: "cli", label: "fetch", root });
	assert.ok(c.ok);
	c.release();
});

test("requireLock: success returns release; other-process conflict throws LockConflictError", async () => {
	const root = tmp();
	const rel = await requireLock(REF, { system: "pi", label: "watch", root });
	rel();

	const other = otherProcess();
	plantLock(root, other.pid, "watch");
	await assert.rejects(
		() => requireLock(REF, { system: "cli", label: "fetch", root }),
		(e: Error) => e instanceof LockConflictError && /one agent at a time/.test(e.message),
	);
	await other.kill();
});

test("dead-pid reclaim: lock from a finished process is taken over", async () => {
	const root = tmp();
	const gone = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
	plantLock(root, gone.pid!, "watch");
	const a = await acquireLock(REF, { system: "pi", label: "fetch", root });
	assert.ok(a.ok, "dead holder reclaimed even for a watch-labelled lock");
	a.release();
});

test("stale one-shot reclaim only; live watch lock held regardless of age", async () => {
	const root = tmp();
	const other = otherProcess();
	// one-shot held by a LIVE OTHER pid, 60m old → stale, reclaimed
	plantLock(root, other.pid, "fetch", new Date(Date.now() - 60 * 60_000).toISOString(), "pi");
	const a = await acquireLock(REF, { system: "cli", label: "put", root });
	assert.ok(a.ok, "stale one-shot lock reclaimed");
	a.release();
	// watch-labelled by a live OTHER pid, same old age → NOT reclaimed
	plantLock(root, other.pid, "watch", new Date(Date.now() - 60 * 60_000).toISOString(), "pi");
	const b = await acquireLock(REF, { system: "cli", label: "fetch", root, waitMs: 50 });
	assert.ok(!b.ok, "live other-process watch lock is not age-reclaimed");
	await other.kill();
});

test("unknown/unreadable lock file is reclaimable; describeHolder('unknown') says so", async () => {
	const root = tmp();
	const dir = path.dirname(lockPath(REF, root));
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(lockPath(REF, root), "{ not json");
	assert.match(describeHolder("unknown"), /can't read/);
	const a = await acquireLock(REF, { system: "pi", label: "put", root });
	assert.ok(a.ok);
	a.release();
});

test("same process never conflicts with itself: watch holder then own fetch/poll passes; noop release keeps file", async () => {
	const root = tmp();
	// the long-lived watch hold (as startWatch does)
	const watchRelease = await requireLock(REF, { system: "pi", label: "watch", root });
	// the same process later fetches/puts its own watched item (gitlab_fetch path)
	const transientRelease = await requireLock(REF, { system: "pi", label: "fetch", root });
	transientRelease();
	assert.ok(
		fs.existsSync(lockPath(REF, root)),
		"transient same-pid release must be a no-op: the watch holder's file survives",
	);
	watchRelease();
	assert.ok(!fs.existsSync(lockPath(REF, root)), "only the real holder's release removes the file");
});
