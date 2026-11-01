import assert from "node:assert/strict";
import { test } from "node:test";
import { labelFor, parseGitLabUrl, slugFor } from "../url.ts";

function ok(u: string) {
	const r = parseGitLabUrl(u);
	assert.equal(r.ok, true, `expected ok for ${u}: ${r.ok ? "" : r.error}`);
	return r.ok ? r.ref : (null as never);
}

test("parses MR urls", () => {
	const ref = ok("https://gitlab.com/my-group/my-project/-/merge_requests/42");
	assert.equal(ref.baseUrl, "https://gitlab.com");
	assert.equal(ref.host, "gitlab.com");
	assert.equal(ref.projectPath, "my-group/my-project");
	assert.equal(ref.kind, "mr");
	assert.equal(ref.iid, 42);
	assert.equal(ref.url, "https://gitlab.com/my-group/my-project/-/merge_requests/42");
});

test("parses issue urls and nested groups", () => {
	const ref = ok("https://gitlab.example.com/a/b/c/proj/-/issues/7");
	assert.equal(ref.kind, "issue");
	assert.equal(ref.iid, 7);
	assert.equal(ref.projectPath, "a/b/c/proj");
});

test("accepts ports, strips trailing slash / query / sub-views", () => {
	const ref = ok("https://gitlab.corp:8443/g/p/-/merge_requests/3/diffs?w=1#note_1");
	assert.equal(ref.host, "gitlab.corp:8443");
	assert.equal(ref.baseUrl, "https://gitlab.corp:8443");
	assert.equal(ref.iid, 3);
	const ref2 = ok("https://gitlab.com/g/p/-/merge_requests/9/");
	assert.equal(ref2.iid, 9);
});

test("rejects non-item urls and bad input", () => {
	for (const u of [
		"https://gitlab.com/g/p",
		"https://gitlab.com/g/p/-/tree/main",
		"gitlab.com/g/p/-/merge_requests/1", // missing scheme
		"ftp://gitlab.com/g/p/-/issues/1",
		"not a url",
		"https://gitlab.com/-/merge_requests/1", // empty project
		"https://gitlab.com/g/p/-/merge_requests/x",
	]) {
		const r = parseGitLabUrl(u);
		assert.equal(r.ok, false, `expected rejection for ${u}`);
		if (!r.ok) assert.match(r.error, /URL|scheme|project path/);
	}
});

test("slug and label", () => {
	const ref = ok("https://gitlab.corp:8443/my-group/sub/my-project/-/merge_requests/42");
	assert.equal(slugFor(ref), "gitlab.corp%3A8443__my-group%2Fsub%2Fmy-project__mr-42");
	assert.equal(labelFor(ref), "!42 my-project (my-group/sub/my-project)");
	assert.equal(labelFor(ref, "Fix the thing"), "!42 my-project (Fix the thing)");
	const issue = ok("https://gitlab.com/g/p/-/issues/4");
	assert.equal(slugFor(issue), "gitlab.com__g%2Fp__issue-4");
	assert.equal(labelFor(issue), "#4 p (g/p)");
});

test("slug is injective: group/proj_x and group_proj/x cannot collide", () => {
	const a = parseGitLabUrl("https://g.example/group/proj_x/-/merge_requests/1");
	const b = parseGitLabUrl("https://g.example/group_proj/x/-/merge_requests/1");
	if (!a.ok || !b.ok) throw new Error("parse failed");
	assert.notEqual(slugFor(a.ref), slugFor(b.ref));
	assert.notEqual(slugFor(a.ref), slugFor(b.ref));
});
