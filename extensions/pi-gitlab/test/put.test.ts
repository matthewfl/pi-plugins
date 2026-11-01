import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { GitLabClient, type Discussion } from "../client.ts";
import type { ItemSnapshot } from "../fetch.ts";
import {
	type Document,
	parseDocument,
	serializeDocument,
} from "../format.ts";
import {
	annotateFailuresInFile,
	buildPositionBody,
	computeActions,
	describeAction,
	ensureSignature,
	executeActions,
	reconcileFileText,
	staleBaselineIssue,
	wrapForPost,
	type Action,
} from "../put.ts";
import { parseGitLabUrl, type GitLabItemRef } from "../url.ts";

const SIG = "_🤖 Automatically written by pi-gitlab (AI agent). Review before acting._";
const OPERATOR = "alice";

function refOf(url: string, kind?: "mr" | "issue"): GitLabItemRef {
	const r = parseGitLabUrl(url);
	assert.ok(r.ok);
	return r.ref;
}
const REF = refOf("https://gitlab.com/g/p/-/merge_requests/42");
const ISSUE_REF = refOf("https://gitlab.com/g/p/-/issues/7");

let noteId = 100;
function note(author: string, body: string, extra: Record<string, unknown> = {}) {
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
	return { id, individual_note: false, notes: notes as Discussion["notes"] };
}

const DIFFS = [
	{
		old_path: "src/api/client.ts",
		new_path: "src/api/client.ts",
		diff: "@@ -48,1 +48,3 @@\n ctx48\n+added49\n+added50\n ctx51",
	},
];

function mrSnap(over: Partial<ItemSnapshot> = {}): ItemSnapshot {
	return {
		ref: REF,
		title: "T",
		description: "server desc",
		state: "opened",
		draft: false,
		headSha: "abc",
		diffRefs: { base_sha: "b", start_sha: "s", head_sha: "h" },
		authorUsername: OPERATOR,
		serverUpdatedAt: "2024-05-02T14:20:05Z",
		discussions: [],
		codeContexts: new Map(),
		diffs: DIFFS,
		...over,
	};
}

/** Minimal doc builder: root + description + given raw block lines. */
function docOf(ref: GitLabItemRef, description: string, blocks: string[]): Document {
	const kind = ref.kind === "mr" ? "gitlab-mr" : "gitlab-issue";
	const text = [
		`<${kind} source="${ref.url}" iid="${ref.iid}" title="T" state="opened" author="@x" operator_author="true" fetched_at="2024-05-02T14:20:05Z">`,
		"",
		"<description>",
		description,
		"</description>",
		"",
		...blocks,
		`</${kind}>`,
		"",
	].join("\n");
	return parseDocument(text);
}
function textOf(doc: Document): string {
	return serializeDocument(doc);
}

// ─── §4.3 table rows ─────────────────────────────────────────────────

test("staged reply inside published thread → POST reply action", () => {
	const doc = docOf(REF, "server desc", [
		'<discussion_thread id="d1" resolved="false">',
		"",
		'<comment author="@bob" id="1" from_operator="false">',
		"please fix",
		"</comment>",
		"",
		'<comment author="pi" id="unset" visible="unpublished" from_operator="false">',
		"fixed in abc123",
		"</comment>",
		"",
		"</discussion_thread>",
	]);
	const server = mrSnap({ discussions: [disc("d1", [note("bob", "please fix", { id: 1 })])] });
	const r = computeActions(doc, server, OPERATOR, textOf(doc));
	assert.equal(r.errors.length, 0);
	assert.equal(r.actions.length, 1);
	assert.equal(r.actions[0].type, "reply");
	if (r.actions[0].type === "reply") {
		assert.equal(r.actions[0].discussionId, "d1");
		assert.equal(r.actions[0].body, "fixed in abc123");
	}
});

test("draft top-level thread → new_discussion without position", () => {
	const doc = docOf(REF, "server desc", [
		'<discussion_thread id="unset" visible="unpublished">',
		"",
		'<comment author="pi" id="unset" visible="unpublished" from_operator="false">',
		"standalone summary",
		"</comment>",
		"",
		"</discussion_thread>",
	]);
	const r = computeActions(doc, mrSnap(), OPERATOR, textOf(doc));
	assert.equal(r.errors.length, 0);
	const a = r.actions[0];
	assert.equal(a.type, "new_discussion");
	if (a.type === "new_discussion") assert.equal(a.position, undefined);
});

test("draft code thread → position validated against current diff", () => {
	const mkBlocks = (line: number) => [
		`<discussion_thread id="unset" file="src/api/client.ts" line="${line}" side="new" visible="unpublished">`,
		"",
		'<comment author="pi" id="unset" visible="unpublished" from_operator="false">',
		"review note",
		"</comment>",
		"",
		"</discussion_thread>",
	];
	const good = computeActions(docOf(REF, "server desc", mkBlocks(50)), mrSnap(), OPERATOR, "");
	assert.equal(good.errors.length, 0);
	const a = good.actions[0];
	assert.equal(a.type, "new_discussion");
	if (a.type === "new_discussion") {
		assert.deepEqual(a.position, { file: "src/api/client.ts", line: 50, side: "new" });
	}
	const bad = computeActions(docOf(REF, "server desc", mkBlocks(999)), mrSnap(), OPERATOR, "");
	assert.equal(bad.errors.length, 1);
	assert.match(bad.errors[0].message, /not a commentable line/);
});

test("code thread on an issue → error", () => {
	const doc = docOf(ISSUE_REF, "server desc", [
		'<discussion_thread id="unset" file="a.ts" line="3" side="new" visible="unpublished">',
		"",
		'<comment author="pi" id="unset" visible="unpublished" from_operator="false">',
		"x",
		"</comment>",
		"",
		"</discussion_thread>",
	]);
	const server = mrSnap({ ref: ISSUE_REF, diffs: [] });
	const r = computeActions(doc, server, OPERATOR, textOf(doc));
	assert.match(r.errors[0]?.message ?? "", /not possible on issues/);
});

test("resolve flip ↔ server state; issue resolve errors", () => {
	const doc = docOf(REF, "server desc", ['<discussion_thread id="d1" resolved="true">', "", "</discussion_thread>"]);
	const server = mrSnap({ discussions: [disc("d1", [note("bob", "q?")])] });
	const r = computeActions(doc, server, OPERATOR, textOf(doc));
	assert.equal(r.errors.length, 0);
	assert.equal(r.actions[0]?.type, "resolve", "expected a resolve action");
	if (r.actions[0]?.type === "resolve") assert.equal(r.actions[0].resolved, true);

	// already equal → no action
	const doc2 = docOf(REF, "server desc", ['<discussion_thread id="d1" resolved="false">', "", "</discussion_thread>"]);
	assert.equal(computeActions(doc2, server, OPERATOR, textOf(doc2)).actions.length, 0);

	// issue: error
	const idoc = docOf(ISSUE_REF, "server desc", ['<discussion_thread id="d1" resolved="true">', "", "</discussion_thread>"]);
	const iserver = mrSnap({ ref: ISSUE_REF, discussions: [disc("d1", [note("bob", "q?")])] });
	const ir = computeActions(idoc, iserver, OPERATOR, textOf(idoc));
	assert.match(ir.errors[0]?.message ?? "", /no resolvable threads/);
});

test("description change: author ok; non-author needs non_owner", () => {
	const doc = docOf(REF, "edited description", []);
	const server = mrSnap({ authorUsername: "carol" });
	const bad = computeActions(doc, server, OPERATOR, textOf(doc));
	assert.equal(bad.errors.length, 1);
	assert.match(bad.errors[0].message, /non_owner="true"/);

	// with the flag
	const doc2 = docOf(REF, "edited description", []);
	const desc2 = doc2.blocks.find((b) => b.type === "description");
	if (desc2?.type === "description") desc2.nonOwner = true;
	const good = computeActions(doc2, server, OPERATOR, textOf(doc2));
	assert.equal(good.errors.length, 0);
	assert.equal(good.actions[0].type, "update_description");
	if (good.actions[0].type === "update_description") assert.equal(good.actions[0].nonOwner, true);

	// own item: fine without flag
	const own = computeActions(doc, mrSnap({ authorUsername: OPERATOR }), OPERATOR, textOf(doc));
	assert.equal(own.errors.length, 0);
	assert.equal(own.actions[0].type, "update_description");
});

test("published comment edit requires update_existing_comment", () => {
	const blocks = (flag: string) => [
		'<discussion_thread id="d1" resolved="false">',
		"",
		`<comment author="@alice" id="1" from_operator="true"${flag}>`,
		"edited body",
		"</comment>",
		"",
		"</discussion_thread>",
	];
	const server = mrSnap({ discussions: [disc("d1", [note(OPERATOR, "original body", { id: 1 })])] });
	const bad = computeActions(docOf(REF, "server desc", blocks("")), server, OPERATOR, "");
	assert.equal(bad.errors.length, 1);
	assert.match(bad.errors[0].message, /update_existing_comment="true"/);

	const good = computeActions(
		docOf(REF, "server desc", blocks(' update_existing_comment="true"')),
		server, OPERATOR, "",
	);
	assert.equal(good.errors.length, 0);
	assert.equal(good.actions[0].type, "update_note");
	if (good.actions[0].type === "update_note") {
		assert.equal(good.actions[0].noteId, 1);
		assert.equal(good.actions[0].body, "edited body");
	}
});

test("structural errors: draft with server id, unknown thread, deleted note, empty body", () => {
	const server = mrSnap({ discussions: [disc("d1", [note("bob", "hi")])] });
	const mk = (...lines: string[]) => docOf(REF, "server desc", lines);

	let r = computeActions(
		mk('<discussion_thread id="d1" resolved="false">', "",
			'<comment author="pi" id="77" visible="unpublished" from_operator="false">', "x", "</comment>",
			"", "</discussion_thread>"),
		server, OPERATOR, "");
	assert.match(r.errors[0]?.message ?? "", /id="unset"/);

	r = computeActions(
		mk('<discussion_thread id="zzz" resolved="false">', "",
			'<comment author="pi" id="unset" visible="unpublished" from_operator="false">', "x", "</comment>",
			"", "</discussion_thread>"),
		server, OPERATOR, "");
	assert.match(r.errors[0]?.message ?? "", /no longer exists/);

	r = computeActions(
		mk('<discussion_thread id="d1" resolved="false">', "",
			'<comment author="@alice" id="999" from_operator="true">', "edited", "</comment>",
			"", "</discussion_thread>"),
		server, OPERATOR, "");
	assert.match(r.errors[0]?.message ?? "", /no longer exists/);

	r = computeActions(
		mk('<discussion_thread id="unset" visible="unpublished">', "",
			'<comment author="pi" id="unset" visible="unpublished" from_operator="false">', "</comment>",
			"", "</discussion_thread>"),
		server, OPERATOR, "");
	assert.match(r.errors[0]?.message ?? "", /empty/i);
});

test("conflict markers block everything (plan §7)", () => {
	const doc = docOf(REF, "server desc", []);
	const raw = textOf(doc) + "<<<<<<< staged\n=======\n>>>>>>> server\n";
	const r = computeActions(doc, mrSnap(), OPERATOR, raw);
	assert.equal(r.actions.length, 0);
	assert.equal(r.errors.length, 1);
	assert.match(r.errors[0].message, /merge conflict marker/);
});

test ("stale baseline: dry_run warns, submit errors", () => {
	const doc = docOf(REF, "server desc", []);
	const server = mrSnap({ serverUpdatedAt: "2024-05-03T09:00:00Z" });
	assert.equal(staleBaselineIssue(doc, server, "dry_run")?.level, "warning");
	assert.equal(staleBaselineIssue(doc, server, "submit")?.level, "error");
	const fresh = mrSnap();
	assert.equal(staleBaselineIssue(doc, fresh, "submit"), null);
});

test("duplicate guard: newest note from operator + staged reply → warning", () => {
	const doc = docOf(REF, "server desc", [
		'<discussion_thread id="d1" resolved="false">',
		"",
		'<comment author="@alice" id="1" from_operator="true">',
		"my earlier answer",
		"</comment>",
		"",
		'<comment author="pi" id="unset" visible="unpublished" from_operator="false">',
		"saying it again",
		"</comment>",
		"",
		"</discussion_thread>",
	]);
	const server = mrSnap({ discussions: [disc("d1", [note(OPERATOR, "my earlier answer", { id: 1 })])] });
	const r = computeActions(doc, server, OPERATOR, textOf(doc));
	assert.equal(r.errors.length, 0);
	assert.equal(r.warnings.length, 1);
	assert.match(r.warnings[0].message, /duplicate/);
});

// ─── Signature / position bodies ─────────────────────────────────────

test("signature wrap + ensure (no duplication)", () => {
	assert.equal(wrapForPost(SIG, "hi"), `${SIG}\n\nhi`);
	assert.equal(ensureSignature(SIG, `intro ${SIG} tail`), `intro ${SIG} tail`);
	assert.equal(ensureSignature(SIG, "plain"), `${SIG}\n\nplain`);
});

test("buildPositionBody for new/old side", () => {
	const refs = { base_sha: "b", start_sha: "s", head_sha: "h" };
	assert.deepEqual(buildPositionBody({ file: "a.ts", line: 9, side: "new" }, refs), {
		position_type: "text", base_sha: "b", start_sha: "s", head_sha: "h",
		old_path: "a.ts", new_path: "a.ts", new_line: 9,
	});
	assert.deepEqual(buildPositionBody({ file: "a.ts", line: 9, side: "old" }, refs), {
		position_type: "text", base_sha: "b", start_sha: "s", head_sha: "h",
		old_path: "a.ts", new_path: "a.ts", old_line: 9,
	});
});

// ─── Executor ────────────────────────────────────────────────────────

type Call = { url: string; method: string; body?: Record<string, unknown> };
function queuedClient(responses: { status: number; json: unknown }[]) {
	const calls: Call[] = [];
	const fetchImpl = (async (url: unknown, init?: RequestInit) => {
		calls.push({
			url: String(url), method: init?.method ?? "GET",
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		});
		const r = responses.shift();
		if (!r) throw new Error("queue exhausted");
		return new Response(JSON.stringify(r.json), {
			status: r.status, headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	return { calls, client: new GitLabClient("https://g", "tok", { fetchImpl }) };
}

function srcComment(body: string): never {
	return { body } as never;
}

test("executor: order, signature wrap, position posting; pacing called", async () => {
	const { calls, client } = queuedClient([
		{ status: 200, json: { id: 1 } },
		{ status: 200, json: { id: "d", individual_note: false, notes: [] } },
	]);
	const actions: Action[] = [
		{ type: "reply", discussionId: "d1", body: "reply text", bypassSignature: false, source: srcComment("reply text") },
		{ type: "new_discussion", body: "code note", bypassSignature: false, position: { file: "a.ts", line: 9, side: "new" }, source: null as never },
	];
	const sleeps: number[] = [];
	const outcomes = await executeActions(client, REF, actions, {
		signatureHeader: SIG, operatorUsername: OPERATOR,
		diffRefs: { base_sha: "b", start_sha: "s", head_sha: "h" },
		sleep: async (ms) => { sleeps.push(ms); },
		paceMs: 5,
	});
	assert.deepEqual(outcomes.map((o) => o.ok), [true, true]);
	assert.match(String(calls[0].body?.body), new RegExp(`^${SIG.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n\\nreply text$`));
	assert.equal(String(calls[1].body?.body).endsWith("code note"), true);
	assert.deepEqual((calls[1].body?.position as Record<string, unknown>)?.new_line, 9);
	assert.equal(sleeps.length, 2);
});

test("executor: 403 aborts remaining actions (marked not attempted)", async () => {
	const { client } = queuedClient([{ status: 403, json: { message: "forbidden" } }]);
	const actions: Action[] = [
		{ type: "reply", discussionId: "d1", body: "one", bypassSignature: false, source: null as never },
		{ type: "reply", discussionId: "d2", body: "two", bypassSignature: false, source: null as never },
		{ type: "reply", discussionId: "d3", body: "three", bypassSignature: false, source: null as never },
	];
	const outcomes = await executeActions(client, REF, actions, {
		signatureHeader: SIG, operatorUsername: OPERATOR, sleep: async () => {}, paceMs: 0,
	});
	assert.deepEqual(
		outcomes.map((o) => [o.ok, o.notAttempted ?? false]),
		[[false, false], [false, true], [false, true]],
	);
});

test("executor: 400 does NOT abort; non-owner description footer", async () => {
	const { calls, client } = queuedClient([
		{ status: 400, json: { message: "bad anchor" } },
		{ status: 200, json: {} },
	]);
	const actions: Action[] = [
		{ type: "new_discussion", body: "n", bypassSignature: false, position: { file: "a", line: 1, side: "new" }, source: null as never },
		{ type: "update_description", body: "new desc", nonOwner: true, source: null as never },
	];
	const outcomes = await executeActions(client, REF, actions, {
		signatureHeader: SIG, operatorUsername: OPERATOR,
		diffRefs: { base_sha: "b", start_sha: "s", head_sha: "h" },
		sleep: async () => {}, paceMs: 0,
	});
	assert.deepEqual(outcomes.map((o) => o.ok), [false, true]);
	assert.match(String(calls[1].body?.description), /acting for @alice/);
});

test("executor: update_note dedups signature", async () => {
	const { calls, client } = queuedClient([{ status: 200, json: { id: 9 } }]);
	const body = `${SIG}\n\nalready wrapped edit`;
	await executeActions(client, REF, [{ type: "update_note", discussionId: "d", noteId: 9, body, bypassSignature: false, source: null as never }], {
		signatureHeader: SIG, operatorUsername: OPERATOR, sleep: async () => {}, paceMs: 0,
	});
	assert.equal(calls[0].body?.body, body);
});

test("describeAction summaries", () => {
	const lines = [
		{ type: "reply", discussionId: "abcdefghij", body: "hi", bypassSignature: false, source: null as never },
		{ type: "resolve", discussionId: "abcdefghij", resolved: true, source: null as never },
	] as Action[];
	assert.match(describeAction(lines[0], 0), /1\. reply in thread abcdefgh… — hi/);
	assert.match(describeAction(lines[1], 1), /2\. resolve thread abcdefgh…/);
});

// ─── Failure annotations ─────────────────────────────────────────────

test("annotateFailuresInFile inserts marker above the failed draft", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gitlab-annotate-"));
	const file = path.join(root, "f.gitlab.md");
	await fs.writeFile(file, [
		'<gitlab-mr source="https://g/p/-/merge_requests/1" iid="1" title="t" state="opened" author="@a" operator_author="true" fetched_at="x">',
		"",
		'<discussion_thread id="d1" resolved="false">',
		"",
		'<comment author="pi" id="unset" visible="unpublished" from_operator="false">',
		"this will fail",
		"</comment>",
		"",
		"</discussion_thread>",
		"",
		"</gitlab-mr>",
		"",
	].join("\n"), "utf8");
	const n = await annotateFailuresInFile(file, [{ body: "this will fail", error: "400: bad anchor" }]);
	assert.equal(n, 1);
	const text = await fs.readFile(file, "utf8");
	assert.match(text, /<!-- put FAIL: 400: bad anchor -->\n<comment author="pi"/);
});

// ─── post-submit file reconciliation (double-post guard) ─────────────

test("reconcile removes the staged reply draft, keeps other drafts", () => {
	const text = [
		'<gitlab-mr source="https://g/p/-/merge_requests/1" iid="1" title="t" state="opened" author="@op" operator_author="true" fetched_at="2026-01-01T00:00:00Z">',
		"",
		'<discussion_thread id="disc1" resolved="false">',
		"",
		'<comment author="@alice" id="10">',
		"please fix",
		"</comment>",
		"",
		'<comment author="pi" id="unset" visible="unpublished">',
		"posted reply body",
		"</comment>",
		"",
		'<comment author="pi" id="unset" visible="unpublished">',
		"still pending second reply",
		"</comment>",
		"",
		"</discussion_thread>",
		"",
		"</gitlab-mr>",
		"",
	].join("\n");
	const out = reconcileFileText(text, [
		{ action: { type: "reply", discussionId: "disc1", body: "posted reply body", bypassSignature: false, source: {} as never }, ok: true, postedBody: "_sig_\n\nposted reply body" },
	]);
	assert.ok(!out.includes("posted reply body"), "posted draft removed");
	assert.ok(out.includes("still pending second reply"), "other staged drafts kept");
	assert.ok(out.includes("please fix"), "published content kept");
	parseDocument(out);
});

test("reconcile removes posted thread and syncs description/note to posted bodies", () => {
	const text = [
		'<gitlab-mr source="https://g/p/-/merge_requests/1" iid="1" title="t" state="opened" author="@op" operator_author="true" fetched_at="2026-01-01T00:00:00Z">',
		"",
		"<description>",
		"new description text",
		"</description>",
		"",
		'<discussion_thread id="disc9" resolved="false">',
		'<comment author="pi" id="55" via_pi="true" update_existing_comment="true">',
		"old body edited locally",
		"</comment>",
		"</discussion_thread>",
		"",
		'<discussion_thread id="unset" visible="unpublished">',
		'<comment author="pi" id="unset" visible="unpublished">',
		"standalone comment that got posted",
		"</comment>",
		"</discussion_thread>",
		"",
		"</gitlab-mr>",
		"",
	].join("\n");
	const footerBody = "new description text\n\n_Description updated via pi-gitlab (AI agent) acting for @op._";
	const out = reconcileFileText(text, [
		{ action: { type: "new_discussion", body: "standalone comment that got posted", bypassSignature: false, source: {} as never }, ok: true, postedBody: "_sig_\n\nstandalone comment that got posted" },
		{ action: { type: "update_description", body: "new description text", nonOwner: true, source: {} as never }, ok: true, postedBody: footerBody },
		{ action: { type: "update_note", discussionId: "disc9", noteId: 55, body: "old body edited locally", bypassSignature: false, source: {} as never }, ok: true, postedBody: "_sig_\n\nold body edited locally" },
		{ action: { type: "resolve", discussionId: "disc1", resolved: true, source: {} as never }, ok: true },
	]);
	assert.ok(!out.includes("standalone comment that got posted"), "posted thread removed");
	assert.ok(out.includes(footerBody), "description synced to posted body (footer)");
	assert.ok(out.includes("_sig_\n\nold body edited locally"), "note synced to posted body (signature ensured)");
	assert.ok(!out.includes('<discussion_thread id="unset"'), "no staged thread remains");
	assert.ok(!out.includes("update_existing_comment"), "one-shot edit flag stripped after success");
	parseDocument(out);
});

test("reconcile leaves failed / not-attempted drafts in place", () => {
	const staged = [
		'<gitlab-mr source="https://g/p/-/merge_requests/1" iid="1" title="t" state="opened" author="@op" operator_author="true" fetched_at="2026-01-01T00:00:00Z">',
		"",
		'<discussion_thread id="unset" visible="unpublished">',
		'<comment author="pi" id="unset" visible="unpublished">',
		"draft that failed to post",
		"</comment>",
		"</discussion_thread>",
		"</gitlab-mr>",
		"",
	].join("\n");
	const failAction = { type: "new_discussion", body: "draft that failed to post", bypassSignature: false, source: {} as never } as const;
	const out = reconcileFileText(staged, [
		{ action: failAction, ok: false, error: "400 bad anchor" },
		{ action: failAction, ok: false, notAttempted: true, error: "not attempted" },
	]);
	assert.equal(out, staged, "untouched input stays byte-identical");
});


test("whitelist: computeActions flags bypass; describeAction notes unsigned", () => {
	const doc = docOf(REF, "server desc", [
		'<discussion_thread id="d1" resolved="false">',
		"",
		'<comment author="@bob" id="1" from_operator="false">',
		"run the suite please",
		"</comment>",
		"",
		'<comment author="pi" id="unset" visible="unpublished" from_operator="false">',
		"ci test",
		"</comment>",
		"",
		"</discussion_thread>",
	]);
	const server = mrSnap({ discussions: [disc("d1", [note("bob", "run the suite please", { id: 1 })])] });
	const r = computeActions(doc, server, OPERATOR, textOf(doc), [/ci test/]);
	assert.equal(r.errors.length, 0);
	const act = r.actions[0];
	assert.equal(act.type, "reply");
	assert.ok(act.bypassSignature, "reply flagged for unsigned posting");
	assert.match(describeAction(act, 0), /unsigned — whitelist match/);
	// without patterns the same draft stays signed
	const r2 = computeActions(doc, server, OPERATOR, textOf(doc));
	assert.equal((r2.actions[0] as { bypassSignature: boolean }).bypassSignature, false);
});

test("whitelist: executor posts whitelisted body verbatim and records note id", async () => {
	const { calls, client } = queuedClient([{ status: 200, json: { id: 777 } }]);
	const act: Action = { type: "reply", discussionId: "d1", body: "ci test", bypassSignature: true, source: null as never };
	const out = await executeActions(client, REF, [act], {
		signatureHeader: SIG, operatorUsername: OPERATOR, sleep: async () => {}, paceMs: 0,
	});
	assert.equal(calls[0].body?.body, "ci test", "whitelisted body posted verbatim, no header");
	assert.equal(out[0].postedNoteId, 777, "note id recorded for via_pi persistence");
});

test("whitelist: draft thread flag is body-based", () => {
	const doc = docOf(REF, "server desc", [
		'<discussion_thread id="unset" visible="unpublished">',
		'<comment author="pi" id="unset" visible="unpublished">',
		"/test",
		"</comment>",
		"</discussion_thread>",
	]);
	const yes = computeActions(doc, mrSnap(), OPERATOR, textOf(doc), [/^\/test$/]);
	assert.equal(yes.actions[0].type, "new_discussion");
	assert.equal((yes.actions[0] as { bypassSignature: boolean }).bypassSignature, true);
	const no = computeActions(doc, mrSnap(), OPERATOR, textOf(doc), [/^\/merge$/]);
	assert.equal((no.actions[0] as { bypassSignature: boolean }).bypassSignature, false);
});

test("executor: descriptions NEVER carry the signature header (own verbatim; footer is not the banner)", async () => {
	const { calls: cOwn, client: own } = queuedClient([{ status: 200, json: {} }]);
	await executeActions(own, REF, [{ type: "update_description", body: "fresh description", nonOwner: false, source: null as never }], {
		signatureHeader: SIG, operatorUsername: OPERATOR, sleep: async () => {}, paceMs: 0,
	});
	assert.equal(cOwn[0].body?.description, "fresh description", "own MR posts the staged body verbatim");

	const { calls: cNo, client: no } = queuedClient([{ status: 200, json: {} }]);
	await executeActions(no, REF, [{ type: "update_description", body: "fresh description", nonOwner: true, source: null as never }], {
		signatureHeader: SIG, operatorUsername: OPERATOR, sleep: async () => {}, paceMs: 0,
	});
	assert.equal(
		cNo[0].body?.description,
		`fresh description\n\n_Description updated via pi-gitlab (AI agent) acting for @${OPERATOR}._`,
		"non-owner gets the provenance footer, never the signature banner",
	);
});

test("title change: own item posts update_title; identical title is a no-op", () => {
	const doc = docOf(REF, "server desc", []);
	doc.root.title = "Renamed by pi";
	const r = computeActions(doc, mrSnap(), OPERATOR, textOf(doc));
	assert.equal(r.errors.length, 0);
	assert.equal(r.actions.length, 1);
	assert.equal(r.actions[0].type, "update_title");
	if (r.actions[0].type === "update_title") assert.equal(r.actions[0].title, "Renamed by pi");
	const fresh = docOf(REF, "server desc", []);
	assert.equal(computeActions(fresh, mrSnap(), OPERATOR, textOf(fresh)).actions.filter((a) => a.type === "update_title").length, 0);
});

test("title change: non-author needs root-tag non_owner; empty title errors", () => {
	const doc = docOf(REF, "server desc", []);
	doc.root.title = "Renamed by pi";
	const server = mrSnap({ authorUsername: "carol" });
	const bad = computeActions(doc, server, OPERATOR, textOf(doc));
	assert.equal(bad.errors.length, 1);
	assert.match(bad.errors[0].message, /non_owner="true" to the root tag/);
	doc.root.nonOwner = true;
	const good = computeActions(doc, server, OPERATOR, textOf(doc));
	assert.equal(good.errors.length, 0);
	assert.equal(good.actions[0].type, "update_title");
	if (good.actions[0].type === "update_title") assert.equal(good.actions[0].nonOwner, true);
	assert.match(describeAction(good.actions[0], 1), /NON-OWNER title/);
	const blank = docOf(REF, "server desc", []);
	blank.root.title = "   ";
	const r2 = computeActions(blank, mrSnap(), OPERATOR, textOf(blank));
	assert.match(r2.errors[0]?.message ?? "", /title attribute is empty/);
});

test("executor: update_title PUTs the staged title", async () => {
	const { calls, client } = queuedClient([{ status: 200, json: {} }]);
	const outcomes = await executeActions(client, REF, [{ type: "update_title", title: "New name", nonOwner: false }], {
		signatureHeader: SIG, operatorUsername: OPERATOR, sleep: async () => {}, paceMs: 0,
	});
	assert.equal(outcomes[0].ok, true);
	assert.match(calls[0].url, /merge_requests\/42$/);
	assert.equal(calls[0].method, "PUT");
	assert.equal((calls[0].body as Record<string, unknown>).title, "New name");
});
