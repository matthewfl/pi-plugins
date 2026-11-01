import assert from "node:assert/strict";
import { test } from "node:test";
import { restrictedToolSet, unlockedToolSet } from "../activation.ts";
import type { ItemSnapshot } from "../fetch.ts";
import type { GitLabItemRef } from "../url.ts";
import { parseGitLabUrl } from "../url.ts";
import {
	captureSeen,
	classifyChanges,
	formatWatchNotice,
	describeWatchHealth,
	reconstructWatches,
	watchLabel,
	watchStatusText,
	type WatchEntry,
	type WatchHealth,
} from "../watch.ts";

const SIG = "_🤖 Automatically written by pi-gitlab (AI agent). Review before acting._";
const OP = "alice";

function refOf(url: string): GitLabItemRef {
	const r = parseGitLabUrl(url);
	assert.ok(r.ok);
	return r.ref;
}
const REF = refOf("https://gitlab.com/g/p/-/merge_requests/42");

let noteId = 0;
function note(author: string, body: string, extra: Record<string, unknown> = {}) {
	return {
		id: ++noteId, author: { username: author }, body,
		created_at: "t", system: false, resolvable: true, resolved: false, ...extra,
	};
}
function snap(over: Partial<ItemSnapshot>): ItemSnapshot {
	return {
		ref: REF, title: "T", description: "d", state: "opened", draft: false,
		headSha: "aaa111", authorUsername: "bob", serverUpdatedAt: "t1",
		discussions: [], codeContexts: new Map(), diffs: [], ...over,
	};
}

// ─── Tombstone reconstruction ────────────────────────────────────────

test("reconstruct: stop cancels start (any order of later events wins)", () => {
	const entries: WatchEntry[] = [
		{ action: "start", url: "https://gitlab.com/g/p/-/merge_requests/42", intervalSeconds: 60 },
		{ action: "start", url: "https://gitlab.com/g/p/-/issues/7", intervalSeconds: 120 },
		{ action: "stop", url: "https://gitlab.com/g/p/-/merge_requests/42", intervalSeconds: 60 },
	];
	const m = reconstructWatches(entries);
	assert.equal(m.size, 1);
	assert.equal([...m.keys()][0], "https://gitlab.com/g/p/-/issues/7");
});

test("reconstruct: urls normalized (trailing slash, sub-views), interval floor 30", () => {
	const m = reconstructWatches([
		{ action: "start", url: "https://gitlab.com/g/p/-/merge_requests/42/diffs?w=1", intervalSeconds: 5 },
		{ action: "stop", url: "https://gitlab.com/g/p/-/merge_requests/42", intervalSeconds: 90 },
	]);
	assert.equal(m.size, 0);
	const m2 = reconstructWatches([
		{ action: "start", url: "https://gitlab.com/g/p/-/merge_requests/42/diffs", intervalSeconds: 5 },
	]);
	assert.equal([...m2.values()][0].intervalSeconds, 30);
	assert.equal([...m2.keys()][0], "https://gitlab.com/g/p/-/merge_requests/42");
});

// ─── Classification matrix ───────────────────────────────────────────

test("new note → notify; own via_pi post → silent; operator web note → notify", () => {
	const prev = captureSeen(snap({ discussions: [{ id: "d1", individual_note: false, notes: [note("bob", "q") ] as ItemSnapshot["discussions"][number]["notes"] }] }));
	// silence: nothing changed
	assert.equal(classify(prev, snap({ discussions: [{ id: "d1", individual_note: false, notes: [noteFromExisting(1)] }] }), OP, SIG), null);

	function noteFromExisting(_id: number) {
		// identical note id 1 persists → no notification
		return { id: 1, author: { username: "bob" }, body: "q", created_at: "t", system: false, resolvable: true, resolved: false };
	}

	// new note from someone else
	const s2 = snap({ discussions: [{ id: "d1", individual_note: false, notes: [
		{ id: 1, author: { username: "bob" }, body: "q", created_at: "t", system: false, resolvable: true, resolved: false },
		{ id: 2, author: { username: "carol" }, body: "ping", created_at: "t", system: false, resolvable: true, resolved: false },
	] as ItemSnapshot["discussions"][number]["notes"] }] });
	const n2 = classify(prev, s2, OP, SIG);
	assert.equal(n2?.parts[0], "1 new note");

	// own agent post → silent
	const s3 = snap({ discussions: [{ id: "d1", individual_note: false, notes: [
		{ id: 1, author: { username: "bob" }, body: "q", created_at: "t", system: false, resolvable: true, resolved: false },
		{ id: 3, author: { username: OP }, body: SIG + "\n\nreply", created_at: "t", system: false, resolvable: true, resolved: false },
	] as ItemSnapshot["discussions"][number]["notes"] }] });
	assert.equal(classify(prev, s3, OP, SIG), null);

	// operator's own plain web comment → does notify (likely an instruction)
	const s4 = snap({ discussions: [{ id: "d1", individual_note: false, notes: [
		{ id: 1, author: { username: "bob" }, body: "q", created_at: "t", system: false, resolvable: true, resolved: false },
		{ id: 4, author: { username: OP }, body: "please also update the changelog", created_at: "t", system: false, resolvable: true, resolved: false },
	] as ItemSnapshot["discussions"][number]["notes"] }] });
	assert.match(classify(prev, s4, OP, SIG)?.parts[0] ?? "", /1 new note/);

	// system note never notifies
	const s5 = snap({ discussions: [{ id: "d1", individual_note: false, notes: [
		{ id: 1, author: { username: "bob" }, body: "q", created_at: "t", system: false, resolvable: true, resolved: false },
		{ id: 5, author: { username: "gitlab" }, body: "added 1 commit", created_at: "t", system: true, resolvable: false, resolved: false },
	] as ItemSnapshot["discussions"][number]["notes"] }] });
	assert.equal(classify(prev, s5, OP, SIG), null);
});

test("resolve flip, head move, pipeline terminal-only, merged → terminal", () => {
	const noteUnresolved = { id: 9, author: { username: "b" }, body: "x", created_at: "t", system: false, resolvable: true, resolved: false };
	const discUnresolved = [{ id: "d1", individual_note: false, notes: [noteUnresolved] as ItemSnapshot["discussions"][number]["notes"] }];
	const prev = captureSeen(snap({ headSha: "aaa111", pipeline: "running", discussions: discUnresolved }));

	// resolve flip: same note id, now resolved
	const flip = classify(prev, snap({ headSha: "aaa111", pipeline: "running",
		discussions: [{ id: "d1", individual_note: false, notes: [{ ...noteUnresolved, resolved: true }] as ItemSnapshot["discussions"][number]["notes"] }] }), OP, SIG);
	assert.ok(flip);
	assert.ok(flip.parts.some((p) => /resolve flip/.test(p)));
	assert.ok(!flip.parts.some((p) => /new note/.test(p)), "same id → not counted as new");

	// head move
	const moved = classify(prev, snap({ headSha: "bbb222", pipeline: "running" }), OP, SIG);
	assert.ok(moved?.parts.some((p) => /head moved aaa111→bbb222/.test(p)));

	// pipeline progress silent, terminal notifies
	const prog = classify(prev, snap({ headSha: "aaa111", pipeline: "pending" }), OP, SIG);
	assert.equal(prog, null);
	const done = classify(prev, snap({ headSha: "aaa111", pipeline: "failed" }), OP, SIG);
	assert.ok(done?.parts.some((p) => /pipeline failed/.test(p)));
	// terminal → terminal stays silent
	const prevFailed = captureSeen(snap({ headSha: "aaa111", pipeline: "failed" }));
	assert.equal(classify(prevFailed, snap({ headSha: "aaa111", pipeline: "success" }), OP, SIG), null);

	// merged → terminal
	const merged = classify(prev, snap({ headSha: "aaa111", state: "merged" }), OP, SIG);
	assert.equal(merged?.terminal, true);
	assert.equal(merged?.terminalReason, "merged");
});

test("formatWatchNotice line (+conflict warning)", () => {
	const n = { parts: ["2 new notes", "head moved a→b"], terminal: false, hasNotes: true };
	const line = formatWatchNotice("!42 p (T)", n, "/f/p.gitlab.md", false);
	assert.match(line, /\[gitlab watch\] !42 p \(T\): 2 new notes, head moved a→b\./);
	assert.match(line, /file: \/f\/p\.gitlab\.md \(delta: \/f\/p\.gitlab\.md\.diff\)/);
	const conflict = formatWatchNotice("!42 p (T)", n, "/f/p.gitlab.md", true);
	assert.match(conflict, /merged with conflicts/);
});

// ─── Staged activation policy ────────────────────────────────────────

test("activation: restrict removes gated; unlock adds once", () => {
	const all = ["read", "write", "gitlab_fetch", "gitlab_put", "gitlab_watch"];
	assert.deepEqual(restrictedToolSet(all), ["read", "write", "gitlab_fetch"]);
	const cur = ["read", "gitlab_fetch"];
	assert.deepEqual(unlockedToolSet(cur), ["read", "gitlab_fetch", "gitlab_put", "gitlab_watch"]);
	assert.equal(unlockedToolSet(all), null, "already unlocked → no call");
});


test("unsigned own post stays silent via recorded id and whitelist pattern", () => {
	const bob = note("bob", "q");
	const mine = note(OP, "ci test");
	const prev = captureSeen(snap({
		discussions: [{ id: "d1", individual_note: false, notes: [bob] }],
	}));
	const next = snap({
		discussions: [{ id: "d1", individual_note: false, notes: [bob, mine] }],
	});
	// no extra info → the unsigned new note notifies
	assert.ok(classify(prev, next, OP, SIG) !== null);
	// recorded id → silent
	assert.equal(classify(prev, next, OP, SIG, { viaPiNoteIds: new Set([mine.id]) }), null);
	// whitelist pattern → silent
	assert.equal(classify(prev, next, OP, SIG, { bypass: [/ci test/] }), null);
});

test("prose mentioning a trigger still notifies; verbatim full-body matches stay silent", () => {
	const bob = note("bob", "q");
	const prose = note(OP, "check why the /test run failed");
	const prev = captureSeen(snap({
		discussions: [{ id: "d1", individual_note: false, notes: [bob] }],
	}));
	const next = snap({
		discussions: [{ id: "d1", individual_note: false, notes: [bob, prose] }],
	});
	const bypass = [/ci test/, /\/test/];
	assert.ok(classify(prev, next, OP, SIG, { bypass }) !== null,
		"a comment merely mentioning /test still notifies");
	const verbatim = snap({
		discussions: [{ id: "d1", individual_note: false, notes: [bob, note(OP, "/test")] }],
	});
	assert.equal(classify(prev, verbatim, OP, SIG, { bypass }), null,
		"verbatim trigger body stays silent");
});

test("watchStatusText: labels shown, two max then +N more", () => {
	assert.equal(watchStatusText([]), undefined);
	assert.equal(watchStatusText(["!1 agents"]), "gitlab: watching !1 agents");
	assert.equal(watchStatusText(["!1 agents", "#2 api"]), "gitlab: watching !1 agents, #2 api");
	assert.equal(
		watchStatusText(["!1 a", "#2 b", "!3 c", "!4 d"]),
		"gitlab: watching !1 a, #2 b +2 more",
	);
});

test("watchLabel: mr ! / issue #, project leaf", () => {
	assert.equal(watchLabel({ kind: "mr", iid: 1, projectPath: "g/agents" }), "!1 agents");
	assert.equal(watchLabel({ kind: "issue", iid: 2, projectPath: "sub/g/api" }), "#2 api");
});

test("watch: description edits notify; identical descriptions stay silent", () => {
	const notice = classify(captureSeen(snap({ description: "old body" })), snap({ description: "new body" }), OP, SIG);
	assert.ok(notice);
	assert.ok(notice.parts.some((p) => p.includes("description updated")));
	assert.equal(notice.hasNotes, false);
	assert.equal(classify(captureSeen(snap({ description: "same" })), snap({ description: "same" }), OP, SIG), null);
	// trailing-newline tolerance (API round-trip normalization)
	assert.equal(classify(captureSeen(snap({ description: "same" })), snap({ description: "same\n" }), OP, SIG), null);
});

test("watch: legacy seen without a description fingerprint does not false-fire", () => {
	const seen = captureSeen(snap({}));
	delete (seen as { description?: string }).description;
	assert.equal(classify(seen, snap({ description: "anything" }), OP, SIG), null);
});

test("watch: title renames notify; identical titles stay silent", () => {
	const n = classify(captureSeen(snap({ title: "old title" })), snap({ title: "new title" }), OP, SIG);
	assert.ok(n);
	assert.ok(n.parts.some((p) => p.includes("title updated")));
	assert.equal(classify(captureSeen(snap({ title: "same" })), snap({ title: "same" }), OP, SIG), null);
	const seen = captureSeen(snap({}));
	delete (seen as { title?: string }).title;
	assert.equal(classify(seen, snap({ title: "different" }), OP, SIG), null);
});

// ─── classifyChanges attribution ({ notice, suppressed }) ────────────

/** Wrapper so the notice-matrix tests above keep reading the notice. */
function classify(
	prev: Parameters<typeof classifyChanges>[0],
	snapshot: Parameters<typeof classifyChanges>[1],
	op: Parameters<typeof classifyChanges>[2],
	sig: Parameters<typeof classifyChanges>[3],
	opts: Parameters<typeof classifyChanges>[4] = {},
): ReturnType<typeof classifyChanges>["notice"] {
	return classifyChanges(prev, snapshot, op, sig, opts).notice;
}

test("attribution: quiet ticks report WHY they were quiet", () => {
	const prev = captureSeen(snap({}));
	const mine = 7001;
	const s = snap({
		pipeline: "pending",
		discussions: [{
			id: "d9", individual_note: false,
			notes: [
				note("alice", "changed the title of X to Y", { id: 7004, system: true }),
				{ ...note("pi", `${SIG}\nmy own signed reply`), id: 7003 },
				{ ...note("pi", "ci test"), id: mine },
				{ ...note("bot", "/test"), id: 7002 },
				note("bob", "an actual human note"),
			],
		}],
	});
	const res = classifyChanges(prev, s, OP, SIG, { viaPiNoteIds: new Set([mine]), bypass: [/^\/test$/] });
	assert.match(res.notice?.parts[0] ?? "", /1 new note/);
	assert.deepEqual(
		res.suppressed.map((x) => x.reason).sort(),
		["own-recorded-post", "own-signed-post", "pipeline-progress", "system-note", "whitelist-body"],
	);
});

test("attribution: healthy quiet tick — nothing suppressed, null notice", () => {
	const prev = captureSeen(snap({}));
	const res = classifyChanges(prev, snap({}), OP, SIG);
	assert.equal(res.notice, null);
	assert.equal(res.suppressed.length, 0);
});

test("attribution: terminal-to-terminal pipeline move is attributed, not notified", () => {
	const prev = captureSeen(snap({ pipeline: "success" }));
	const res = classifyChanges(prev, snap({ pipeline: "failed" }), OP, SIG);
	assert.equal(res.notice, null);
	assert.deepEqual(res.suppressed.map((x) => x.reason), ["terminal-to-terminal"]);
});

test("describeWatchHealth: no tick, failing, healthy with suppressed summary", () => {
	assert.equal(describeWatchHealth({ lastTickAt: 0, failCount: 0, lastError: null, suppressedSinceArm: {}, notifiedCount: 0 }), "no tick yet");
	const failing = describeWatchHealth({
		lastTickAt: Date.now(), failCount: 3, lastError: "GitLab 401: token rejected", suppressedSinceArm: {}, notifiedCount: 0,
	});
	assert.match(failing, /3 consecutive tick error\(s\)/);
	assert.match(failing, /GitLab 401/);
	const healthy = describeWatchHealth({
		lastTickAt: Date.now() - 45_000, failCount: 0, lastError: null,
		suppressedSinceArm: { "whitelist-body": 2 }, notifiedCount: 1,
	});
	assert.match(healthy, /last tick 45s ago/);
	assert.match(healthy, /1 notified/);
	assert.match(healthy, /2 suppressed \(whitelist-body\)/);
});
