import assert from "node:assert/strict";
import { test } from "node:test";
import { GitLabClient, GitLabError, type Discussion } from "../client.ts";

type Call = { url: string; method: string; headers: Record<string, string>; body?: any };

function fakeFetch(queue: Response[]): { calls: Call[]; fetchImpl: typeof fetch } {
	const calls: Call[] = [];
	const fetchImpl = (async (url: unknown, init?: RequestInit) => {
		calls.push({
			url: String(url),
			method: init?.method ?? "GET",
			headers: (init?.headers ?? {}) as Record<string, string>,
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		});
		const next = queue.shift();
		if (!next) throw new Error("fake fetch queue exhausted");
		return next;
	}) as typeof fetch;
	return { calls, fetchImpl };
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});

test("sends PRIVATE-TOKEN header, encodes project path", async () => {
	const { calls, fetchImpl } = fakeFetch([json({ username: "matthew", id: 1, name: "M" })]);
	const c = new GitLabClient("https://gitlab.example", "glpat-SECRET", { fetchImpl });
	const user = await c.getCurrentUser();
	assert.equal(user.username, "matthew");
	assert.equal(calls[0].headers["PRIVATE-TOKEN"], "glpat-SECRET");
	assert.equal(calls[0].url, "https://gitlab.example/api/v4/user");

	const { calls: c2, fetchImpl: f2 } = fakeFetch([json([] as Discussion[])]);
	const c2l = new GitLabClient("https://gitlab.example", "tok", { fetchImpl: f2 });
	await c2l.listDiscussions("my-group/my.project", "issue", 7);
	assert.match(c2[0].url, /\/projects\/my-group%2Fmy\.project\/issues\/7\/discussions\?per_page=100&page=1$/);
});

test("paginates discussions until a short page", async () => {
	const page = (n: number, start: number) =>
		json(
			Array.from({ length: n }, (_, i) => ({ id: `d${start + i}`, individual_note: false, notes: [] })),
		);
	const full = page(100, 1);
	const last = page(2, 101);
	const { calls, fetchImpl } = fakeFetch([full, last]);
	const c = new GitLabClient("https://g", "t", { fetchImpl });
	const all = await c.listDiscussions("p", "mr", 1);
	assert.equal(all.length, 102);
	assert.equal(calls.length, 2);
});

test("error mapping: 401/403/404 hints, detail from body, token never leaks", async () => {
	const cases: [number, RegExp, RegExp][] = [
		[401, /gitlab-auth/, /invalid token/],
		[403, /"api" scope/, /forbidden/],
		[404, /visibility/, /not here/],
	];
	for (const [status, hintRe, msgRe] of cases) {
		const { fetchImpl } = fakeFetch([json({ message: `hidden ${status} not here invalid token forbidden` }, status)]);
		const c = new GitLabClient("https://g", "tok-secret-123", { fetchImpl });
		try {
			await c.getMergeRequest("p", 1);
			assert.fail("should have thrown");
		} catch (e) {
			const err = e as GitLabError;
			assert.equal(err.status, status);
			assert.match(err.hint ?? "", hintRe);
			assert.match(err.message, msgRe);
			assert.ok(!err.message.includes("tok-secret-123"), "token leaked into error");
			assert.ok(!JSON.stringify(err.hint).includes("tok-secret-123"));
		}
	}
});

test("429 retries once honoring Retry-After", async () => {
	const waits: number[] = [];
	const sleep = async (ms: number) => {
		waits.push(ms);
	};
	const { calls, fetchImpl } = fakeFetch([
		json({ message: "rate limited" }, 429, { "retry-after": "2" }),
		json({ iid: 1, title: "t" }),
	]);
	const c = new GitLabClient("https://g", "t", { fetchImpl, sleep });
	const mr = await c.getMergeRequest("p", 1);
	assert.equal(mr.title, "t");
	assert.deepEqual(waits, [2000]);
	assert.equal(calls.length, 2);
});

test("429 twice → error, no silent success", async () => {
	const { fetchImpl } = fakeFetch([
		json({ message: "slow down" }, 429, { "retry-after": "0" }),
		json({ message: "still limited" }, 429),
	]);
	const c = new GitLabClient("https://g", "t", { fetchImpl, sleep: async () => {} });
	await assert.rejects(c.getIssue("p", 1), (e: GitLabError) => e.status === 429);
});

test("network failure → status 0 error without token", async () => {
	const fetchImpl = (async () => {
		throw new Error("ECONNREFUSED 10.0.0.1");
	}) as typeof fetch;
	const c = new GitLabClient("https://g", "tok-abc", { fetchImpl });
	await assert.rejects(c.getCurrentUser(), (e: GitLabError) => {
		assert.equal(e.status, 0);
		assert.match(e.message, /cannot reach/);
		assert.ok(!e.message.includes("tok-abc"));
		return true;
	});
});

test("write helpers post correct shapes", async () => {
	const { calls, fetchImpl } = fakeFetch([
		json({ id: "d1", individual_note: false, notes: [] }), // createDiscussion w/ position
		json({ id: 11 }), // addNote
		json({ id: 12 }), // updateNote
		json({ id: "d1", individual_note: false, notes: [] }), // resolveDiscussion
		json({}), // updateDescription issue
	]);
	const c = new GitLabClient("https://g", "t", { fetchImpl });
	await c.createDiscussion("p", "mr", 5, "hello", {
		position_type: "text",
		base_sha: "b",
		start_sha: "s",
		head_sha: "h",
		old_path: "a.ts",
		new_path: "a.ts",
		new_line: 42,
	});
	assert.equal(calls[0].method, "POST");
	assert.equal(calls[0].body.body, "hello");
	assert.equal(calls[0].body.position.new_line, 42);

	await c.addNote("p", "mr", 5, "d1", "reply text");
	assert.match(calls[1].url, /discussions\/d1\/notes$/);

	await c.updateNote("p", "issue", 8, "d1", 99, "edited");
	assert.match(calls[2].url, /issues\/8\/discussions\/d1\/notes\/99$/);
	assert.equal(calls[2].method, "PUT");

	await c.resolveDiscussion("p", 5, "d1", true);
	assert.deepEqual(calls[3].body, { resolved: true });
	assert.match(calls[3].url, /merge_requests\/5\/discussions\/d1$/);

	await c.updateDescription("p", "issue", 8, "new body");
	assert.deepEqual(calls[4].body, { description: "new body" });
	assert.match(calls[4].url, /issues\/8$/);
});

test("pagination halves per_page on 5xx and restarts (instance ingress quirk)", async () => {
	const diff = (n: number) => ({ old_path: `a${n}`, new_path: `b${n}`, diff: "@@ x" });
	const ppOf = (u: string) => Number(new URL(u).searchParams.get("per_page"));
	const pageOf = (u: string) => Number(new URL(u).searchParams.get("page"));
	const { calls, fetchImpl } = fakeFetch([
		json({ message: "500 Internal Server Error" }, 500), // pp=100 attempt
		json({ message: "500 Internal Server Error" }, 500), // in-request retry
		json(Array.from({ length: 50 }, (_, i) => diff(i))), // pp=50, page 1: full page
		json([diff(50), diff(51), diff(52)]), // pp=50, page 2: short page ⇒ stop
	]);
	const c = new GitLabClient("https://g", "t", { fetchImpl, sleep: async () => {} });
	const diffs = await c.getMrDiffs("p", 1);
	assert.equal(diffs.length, 53);
	assert.equal(calls.length, 4);
	assert.equal(ppOf(calls[0].url), 100);
	assert.equal(ppOf(calls[2].url), 50);
	assert.equal(pageOf(calls[2].url), 1);
	assert.equal(pageOf(calls[3].url), 2);
});

test("pagination gives up after halving down to the floor", async () => {
	// 100, 50, 25, 12, 10 — 2 calls each (in-request retry), then throw at the floor
	const queue = Array.from({ length: 10 }, () => json({ message: "boom" }, 500));
	const { calls, fetchImpl } = fakeFetch(queue);
	const c = new GitLabClient("https://g", "t", { fetchImpl, sleep: async () => {} });
	await assert.rejects(c.listDiscussions("p", "mr", 1), (e: GitLabError) => e.status === 500);
	assert.equal(calls.length, 10);
	assert.equal(Number(new URL(calls[8].url).searchParams.get("per_page")), 10);
});
