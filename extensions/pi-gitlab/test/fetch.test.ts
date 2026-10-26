import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { Discussion } from "../client.ts";
import {
	applySnapshot,
	buildDocument,
	computeCodeContextLines,
	type ItemSnapshot,
	type RenderOptions,
	runGit,
} from "../fetch.ts";
import { parseDocument, serializeDocument, type CommentEl, type ThreadEl } from "../format.ts";
import { basePath, diffPathFor, itemFilePath, prevPath, statePath } from "../paths.ts";
import { parseGitLabUrl, type GitLabItemRef } from "../url.ts";

const SIG = "_🤖 Automatically written by pi-gitlab (AI agent). Review before acting._";
const OPTS: RenderOptions = { operatorUsername: "alice", signatureHeader: SIG };

function refOf(url: string): GitLabItemRef {
	const r = parseGitLabUrl(url);
	assert.ok(r.ok);
	return r.ref;
}
const REF = refOf("https://gitlab.com/g/p/-/merge_requests/42");

let noteId = 0;
function note(author: string, body: string, extra: Partial<Record<string, unknown>> = {}) {
	return {
		id: ++noteId,
		author: { username: author },
		body,
		created_at: "2024-05-01T10:00Z",
		system: false,
		resolvable: true,
		resolved: false,
		...extra,
	};
}
function disc(id: string, notes: ReturnType<typeof note>[]): Discussion {
	return { id, individual_note: notes.length === 1, notes: notes as Discussion["notes"] };
}

function snap(over: Partial<ItemSnapshot>): ItemSnapshot {
	return {
		ref: REF,
		title: "Fix empty-array handling",
		description: "desc",
		state: "opened",
		draft: false,
		headSha: "9b31f2e",
		authorUsername: "alice",
		serverUpdatedAt: "2024-05-02T14:20:05Z",
		discussions: [],
		codeContexts: new Map(),
		diffs: [],
		...over,
	};
}

async function tmpRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gitlab-fetch-test-"));
	// git merge-file works without a repo, but git must consider the paths legit
	return root;
}

// ─── buildDocument ───────────────────────────────────────────────────

test("buildDocument: via_pi signature detection, from_operator, system notes skipped", () => {
	const s = snap({
		discussions: [
			disc("d1", [
				note("bob", "please fix"),
				note("alice", "on it"),
				note("alice", SIG + "\n\nFixed in 9b31f2e."),
			]),
			disc("sys", [note("alice", "added 3 commits", { system: true })]),
		],
	});
	const doc = buildDocument(s, OPTS);
	const threads = doc.blocks.filter((b): b is ThreadEl => b.type === "thread");
	assert.equal(threads.length, 1, "system-only discussion skipped");
	const comments = threads[0].children.filter((c): c is CommentEl => c.type === "comment");
	assert.equal(comments.length, 3);
	assert.equal(comments[0].fromOperator, false);
	assert.equal(comments[1].fromOperator, true);
	assert.equal(comments[2].viaPi, true);
	assert.equal(comments[2].fromOperator, true);
	assert.equal(threads[0].resolved, false);
});

test("buildDocument: unresolvable threads omit resolved; all-resolved marks true", () => {
	const s = snap({
		discussions: [
			{ id: "indiv", individual_note: true, notes: [note("bob", "ok", { resolvable: false })] as Discussion["notes"] },
			disc("res", [note("bob", "done?", { resolved: true })]),
		],
	});
	const doc = buildDocument(s, OPTS);
	const t1 = doc.blocks.find((b): b is ThreadEl => b.type === "thread" && b.id === "indiv");
	const t2 = doc.blocks.find((b): b is ThreadEl => b.type === "thread" && b.id === "res");
	assert.equal(t1?.resolved, undefined);
	assert.equal(t2?.resolved, true);
});

test("computeCodeContextLines: new side + old side", () => {
	const diffs = [
		{
			old_path: "src/a.ts",
			new_path: "src/a.ts",
			diff: "@@ -10,3 +10,3 @@\n const a = 1;\n-old();\n+added();\n const c = 3;",
		},
	];
	const newSide = computeCodeContextLines(diffs, {
		position_type: "text", base_sha: "b", start_sha: "s", head_sha: "h",
		old_path: "src/a.ts", new_path: "src/a.ts", old_line: null, new_line: 11,
	});
	assert.ok(newSide);
	assert.deepEqual(newSide, [
		"```ts",
		"10  const a = 1;",
		"11  added();   // ← commented line",
		"12  const c = 3;",
		"```",
	]);
	const oldSide = computeCodeContextLines(diffs, {
		position_type: "text", base_sha: "b", start_sha: "s", head_sha: "h",
		old_path: "src/a.ts", new_path: "src/a.ts", old_line: 11, new_line: null,
	});
	assert.ok(oldSide);
	assert.match(oldSide.find((l) => l.includes("commented")) ?? "", /11 {2}old\(\)/);
});

// ─── applySnapshot: first fetch, idempotence, merge, conflict ────────

test("first fetch: file + sidecars + no-change diff", async () => {
	const root = await tmpRoot();
	const s = snap({ discussions: [disc("d1", [note("bob", "hi")])] });
	const res = await applySnapshot(s, OPTS, root, runGit);
	assert.equal(res.firstFetch, true);
	assert.equal(res.conflicted, false);
	const file = await fs.readFile(itemFilePath(REF, root), "utf8");
	const base = await fs.readFile(basePath(REF, root), "utf8");
	assert.equal(file, base, "first fetch: file equals pure server render");
	assert.equal(file, serializeDocument(parseDocument(file)), "file is canonical");
	const diff = await fs.readFile(diffPathFor(res.filePath), "utf8");
	assert.match(diff, /No changes/);
	const state = JSON.parse(await fs.readFile(statePath(REF, root), "utf8"));
	assert.equal(state.sourceUrl, REF.url);
	assert.equal(state.fetchedAt, s.serverUpdatedAt);
});

test("re-fetch with untouched server keeps staged edits silently", async () => {
	const root = await tmpRoot();
	const s = snap({ discussions: [disc("d1", [note("bob", "hi")])] });
	await applySnapshot(s, OPTS, root, runGit);
	const file = itemFilePath(REF, root);
	const withDraft = (await fs.readFile(file, "utf8")).replace(
		"</discussion_thread>",
		'\n<comment author="pi" id="unset" visible="unpublished" from_operator="false">\ndraft\n</comment>\n\n</discussion_thread>',
	);
	await fs.writeFile(file, withDraft, "utf8");
	const res = await applySnapshot(s, OPTS, root, runGit);
	assert.equal(res.serverChanged, false);
	assert.equal(await fs.readFile(file, "utf8"), withDraft, "staged work untouched");
});

test("re-fetch with new server thread merges and keeps staged draft", async () => {
	const root = await tmpRoot();
	const s1 = snap({ discussions: [disc("d1", [note("bob", "hi")])] });
	await applySnapshot(s1, OPTS, root, runGit);
	const file = itemFilePath(REF, root);
	// agent stages a reply in thread d1
	const staged = (await fs.readFile(file, "utf8")).replace(
		"</discussion_thread>",
		'\n<comment author="pi" id="unset" visible="unpublished" from_operator="false">\ndraft reply\n</comment>\n\n</discussion_thread>',
	);
	await fs.writeFile(file, staged, "utf8");
	// server gains a whole new thread
	const s2 = snap({
		serverUpdatedAt: "2024-05-02T15:00:00Z",
		discussions: [disc("d1", [note("bob", "hi")]), disc("d2", [note("carol", "new thread on server")])],
	});
	const res = await applySnapshot(s2, OPTS, root, runGit);
	assert.equal(res.serverChanged, true);
	assert.equal(res.conflicted, false);
	const merged = await fs.readFile(file, "utf8");
	assert.match(merged, /draft reply/, "draft preserved");
	assert.match(merged, /new thread on server/, "server thread landed");
	assert.equal(await fs.readFile(basePath(REF, root), "utf8"), serializeDocument(buildDocument(s2, OPTS)), "base = pure new server render");
	const diff = await fs.readFile(diffPathFor(res.filePath), "utf8");
	assert.match(diff, /\+.*new thread on server/, ".diff shows the addition");
});

test("conflicting edits land as git markers (plan §5.1)", async () => {
	const root = await tmpRoot();
	const s1 = snap({ description: "desc v1" });
	await applySnapshot(s1, OPTS, root, runGit);
	const file = itemFilePath(REF, root);
	// agent edits the description (staged)
	const edited = (await fs.readFile(file, "utf8")).replace("desc v1", "desc staged edit");
	await fs.writeFile(file, edited, "utf8");
	// server also edits the description
	const s2 = snap({ description: "desc from server v2", serverUpdatedAt: "2024-05-02T15:00:00Z" });
	const res = await applySnapshot(s2, OPTS, root, runGit);
	assert.equal(res.conflicted, true);
	const merged = await fs.readFile(file, "utf8");
	assert.match(merged, /^<<<<<<< staged/m);
	assert.match(merged, /desc staged edit/, "staged text inside conflict hunk");
	assert.match(merged, /desc from server v2/, "server text inside conflict hunk");
	assert.match(merged, /^>>>>>>> server/m);
	// base refresh invariant holds even on conflict
	assert.equal(await fs.readFile(basePath(REF, root), "utf8"), serializeDocument(buildDocument(s2, OPTS)));
});

test("put-invariant: base follows snapshot so a just-published block never conflicts", async () => {
	const root = await tmpRoot();
	const s1 = snap({ discussions: [disc("d1", [note("bob", "hi")])] });
	await applySnapshot(s1, OPTS, root, runGit);
	// simulate post-submit: server now has our reply; file was re-rendered by put
	const s2 = snap({
		serverUpdatedAt: "2024-05-02T15:30:00Z",
		discussions: [disc("d1", [note("bob", "hi"), note("alice", SIG + "\n\nreply from agent")])],
	});
	await applySnapshot(s2, OPTS, root, runGit);
	// next tick with same server state: no conflict, no change
	const res = await applySnapshot(s2, OPTS, root, runGit);
	assert.equal(res.serverChanged, false);
	assert.equal(res.conflicted, false);
});

test("root line: staged rename survives server churn without conflict", async () => {
	const root = await tmpRoot();
	const s1 = snap({ discussions: [disc("d1", [note("bob", "hi")])] });
	await applySnapshot(s1, OPTS, root, runGit);
	const file = itemFilePath(REF, root);
	const staged = (await fs.readFile(file, "utf8")).replace(
		/pipeline="[^"]*"/,
		'pipeline="running"',
	).replace(/title="[^"]*"/, 'title="renamed by the agent"');
	await fs.writeFile(file, staged, "utf8");
	// server churn only: state + pipeline move, title still the OLD one
	const s2 = { ...s1, state: "merged", pipeline: "success", serverUpdatedAt: "2024-05-02T15:00:00Z" };
	const res = await applySnapshot(s2, OPTS, root, runGit);
	const out = await fs.readFile(file, "utf8");
	assert.equal(res.conflicted, false, "no conflict markers for an independent rename");
	assert.match(out, /title="renamed by the agent"/, "staged rename preserved");
	assert.match(out, /state="merged"/, "server churn applied");
	assert.match(out, /pipeline="success"/, "server pipeline applied");
	assert.doesNotMatch(out, /<<<<<<</);
});

test("root line: both-sides rename surfaces as conflict markers", async () => {
	const root = await tmpRoot();
	const s1 = snap({ discussions: [disc("d1", [note("bob", "hi")])] });
	await applySnapshot(s1, OPTS, root, runGit);
	const file = itemFilePath(REF, root);
	const staged = (await fs.readFile(file, "utf8")).replace(/title="[^"]*"/, 'title="agent rename"');
	await fs.writeFile(file, staged, "utf8");
	// someone else renamed it in the web UI meanwhile
	const s2 = { ...s1, title: "human rename", serverUpdatedAt: "2024-05-02T15:00:00Z" };
	const res = await applySnapshot(s2, OPTS, root, runGit);
	const out = await fs.readFile(file, "utf8");
	assert.equal(res.conflicted, true, "both-sides rename must conflict, not silently pick one");
	assert.match(out, /<<<<<<< staged/);
	assert.match(out, />>>>>>> server/);
	assert.match(out, /agent rename/);
	assert.match(out, /human rename/);
});

test("root line: post-submit state (staged title == server title) merges clean", async () => {
	const root = await tmpRoot();
	const s1 = snap({ discussions: [disc("d1", [note("bob", "hi")])] });
	await applySnapshot(s1, OPTS, root, runGit);
	const file = itemFilePath(REF, root);
	// agent stages a rename, then submits: the server now has the NEW title
	// and a bumped updated_at; the staged file still carries the old fetched_at
	const staged = (await fs.readFile(file, "utf8")).replace(/title="[^"]*"/, 'title="renamed and posted"');
	await fs.writeFile(file, staged, "utf8");
	const s2 = { ...s1, title: "renamed and posted", serverUpdatedAt: "2024-05-02T15:00:00Z" };
	const res = await applySnapshot(s2, OPTS, root, runGit);
	const out = await fs.readFile(file, "utf8");
	assert.equal(res.conflicted, false, "equal values agree — this is the post-submit state, not a conflict");
	assert.match(out, /title="renamed and posted"/);
	assert.match(out, /fetched_at="2024-05-02T15:00:00Z"/, "server churn applied");
	assert.doesNotMatch(out, /<<<<<<</);
});
