import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	type CommentEl,
	type DescriptionEl,
	type Document,
	findConflictMarkers,
	findDescription,
	findThread,
	FormatError,
	parseDocument,
	serializeDocument,
	type ThreadEl,
} from "../format.ts";

function fixture(name: string): string {
	return readFileSync(new URL(`./fixtures/${name}.gitlab.md`, import.meta.url), "utf8");
}

const VALID = [
	"mr-basic",
	"mr-code-thread",
	"issue-basic",
	"drafts-staged",
	"comments-skipped",
	"mr-markup-bodies",
];

// ─── Structural parse ────────────────────────────────────────────────

test("mr-basic: root attrs and threads", () => {
	const doc = parseDocument(fixture("mr-basic"));
	assert.equal(doc.root.kind, "mr");
	assert.equal(doc.root.iid, 42);
	assert.equal(doc.root.title, "Fix empty-array handling");
	assert.equal(doc.root.operatorAuthor, true);
	assert.equal(doc.root.headSha, "9b31f2e");
	assert.equal(doc.preamble.length, 1);
	const desc = findDescription(doc);
	assert.ok(desc);
	assert.match(desc.body, /regression tests/);
	const threads = doc.blocks.filter((b): b is ThreadEl => b.type === "thread");
	assert.equal(threads.length, 1);
	assert.equal(threads[0].resolved, false);
	const comments = threads[0].children.filter((c): c is CommentEl => c.type === "comment");
	assert.equal(comments.length, 2);
	assert.equal(comments[0].fromOperator, true);
	assert.equal(comments[1].author, "@reviewer");
	assert.match(comments[0].body, /fixed in 9b31f2e/);
});

test("mr-code-thread: code context, position attrs, templates stay comments", () => {
	const doc = parseDocument(fixture("mr-code-thread"));
	const t = findThread(doc, "a3f1c2d455ab9e10");
	assert.ok(t);
	assert.equal(t.file, "src/api/client.ts");
	assert.equal(t.line, 42);
	assert.equal(t.side, "new");
	const kinds = t.children.map((c) => c.type);
	assert.deepEqual(kinds, ["code_context", "comment", "html"]);
	// the end-of-file templates are one html comment block, not real elements
	const htmlCount = doc.blocks.filter((b) => b.type === "html").length;
	assert.equal(htmlCount, 1);
	assert.equal(doc.blocks.filter((b) => b.type === "thread").length, 1);
});

test("issue-basic: issue root has no mr-only attrs", () => {
	const doc = parseDocument(fixture("issue-basic"));
	assert.equal(doc.root.kind, "issue");
	assert.equal(doc.root.draft, undefined);
	assert.equal(doc.root.pipeline, undefined);
	assert.equal(doc.root.headSha, undefined);
	assert.equal(doc.root.operatorAuthor, false);
});

test("drafts-staged: draft reply + draft code thread recognized", () => {
	const doc = parseDocument(fixture("drafts-staged"));
	const threads = doc.blocks.filter((b): b is ThreadEl => b.type === "thread");
	assert.equal(threads.length, 2);
	const [pub, draft] = threads;
	assert.equal(pub.visible, "published");
	const drafts = pub.children.filter(
		(c): c is CommentEl => c.type === "comment" && c.visible === "unpublished",
	);
	assert.equal(drafts.length, 1);
	assert.equal(drafts[0].id, "unset");
	assert.equal(draft.id, "unset");
	assert.equal(draft.visible, "unpublished");
	assert.equal(draft.file, "src/api/client.ts");
	assert.equal(draft.line, 50);
});

test("comments-skipped: html comments never parsed as elements", () => {
	const doc = parseDocument(fixture("comments-skipped"));
	assert.equal(doc.preamble.length, 1);
	assert.equal(doc.blocks.filter((b) => b.type === "thread").length, 0);
	const desc = findDescription(doc) as DescriptionEl;
	assert.equal(desc.body, "real");
	assert.equal(doc.blocks.filter((b) => b.type === "html").length, 1);
});

// ─── Round-trips ─────────────────────────────────────────────────────

test("idempotent serialize on all valid fixtures", () => {
	for (const name of VALID) {
		const once = serializeDocument(parseDocument(fixture(name)));
		const twice = serializeDocument(parseDocument(once));
		assert.equal(twice, once, `${name} not idempotent`);
	}
});

test("byte-identical round-trip on canonical fixtures", () => {
	for (const name of ["mr-basic", "mr-code-thread", "issue-basic", "drafts-staged"]) {
		const text = fixture(name);
		assert.equal(serializeDocument(parseDocument(text)), text, `${name} not canonical`);
	}
});

// ─── Markup in bodies: unknown tags are verbatim content ───────────

test("bodies carry markup verbatim — only OUR tag names are grammar", () => {
	const doc = parseDocument(fixture("mr-markup-bodies"));
	const desc = findDescription(doc);
	assert.ok(desc);
	assert.ok(desc.body.includes("<details>"), "bot block verbatim");
	assert.ok(desc.body.includes("<summary>CI log (click to expand)</summary>"));
	assert.ok(desc.body.includes("</details>"));
	assert.ok(desc.body.includes("&lt;howdy&gt; said the bot"), "entity-looking lines untouched");
	const threads = doc.blocks.filter((b): b is ThreadEl => b.type === "thread");
	const comments = threads.flatMap((t) => t.children).filter((c): c is CommentEl => c.type === "comment");
	assert.ok(comments[0].body.includes("<details>"), "published comment verbatim");
	assert.ok(comments[1].body.startsWith("<b>not bold</b>"), "staged line-leading markup verbatim");
	assert.ok(comments[1].body.includes("Interior markup like <details> needs no special handling"));
});

test("reserved tag name inside a body still errors, naming the &lt;/&gt; escape", () => {
	const bad = fixture("mr-basic").replace("Confirmed, works now.", "<description>\nojops");
	assert.throws(
		() => parseDocument(bad),
		(e: unknown) => e instanceof FormatError && /grammar tag <description> inside <comment> body/.test(e.message) && /&lt;description&gt;/.test(e.message),
	);
});

// ─── Malformed fixtures: errors carry line numbers ───────────────────

function expectFormatError(name: string, line: number, re: RegExp) {
	assert.throws(
		() => parseDocument(fixture(name)),
		(e: unknown) => {
			assert.ok(e instanceof FormatError, `expected FormatError, got ${e}`);
			assert.equal(e.line, line, `${name}: wrong error line`);
			assert.match(e.message, re);
			return true;
		},
	);
}

test("malformed fixtures error with file line numbers", () => {
	expectFormatError("malformed-unclosed-comment", 9, /unclosed <comment>/);
	expectFormatError("malformed-unknown-tag", 3, /unexpected element/);
	expectFormatError("malformed-bad-attr", 3, /side/);
	expectFormatError("malformed-unknown-attr", 5, /unknown attribute "mood"/);
});

test("missing root, content after close", () => {
	assert.throws(() => parseDocument("hello\n"), /expected root element/);
	assert.throws(
		() =>
			parseDocument(
				'<gitlab-issue source="https://g/p/-/issues/1" iid="1" title="t" state="opened" author="@a" operator_author="true" fetched_at="x">\n</gitlab-issue>\nextra\n',
			),
		/content after root close/,
	);
});

// ─── Conflict markers ────────────────────────────────────────────────

test("conflict markers detected with line numbers; short runs ignored", () => {
	const text = [
		"some text",
		"<<<<<<< staged",
		"my edit",
		"||||||| base",
		"orig",
		"=======",
		"server",
		">>>>>>> server",
		"====== six equals are fine",
		"===== five",
	].join("\n");
	const found = findConflictMarkers(text);
	assert.deepEqual(
		found.map((f) => f.line),
		[2, 4, 6, 8],
	);
	assert.equal(findConflictMarkers("no markers\njust text\n").length, 0);
});

// ─── Serializer details ──────────────────────────────────────────────

test("attribute escaping in titles", () => {
	const doc: Document = {
		preamble: [],
		root: {
			kind: "issue",
			source: "https://g/p/-/issues/1",
			iid: 1,
			title: 'has "quotes" & amp',
			state: "opened",
			author: "@a",
			operatorAuthor: true,
			fetchedAt: "x",
		},
		blocks: [],
	};
	const s = serializeDocument(doc);
	assert.match(s, /title="has &quot;quotes&quot; &amp; amp"/);
	const back = parseDocument(s);
	assert.equal(back.root.title, 'has "quotes" & amp');
	assert.equal(serializeDocument(back), s);
});

// ─── Docs consistency ────────────────────────────────────────────────

test("SKILL.md fixture root tag is one literal line (agents imitate it)", () => {
	const skill = readFileSync(new URL("../skills/gitlab-mr-review/SKILL.md", import.meta.url), "utf8");
	const m = skill.match(/<gitlab-mr source=".*>/);
	assert.ok(m, "fixture root tag exists");
	assert.ok(m[0].endsWith(">"), "root tag closes on its own single line");
	assert.match(m[0], /fetched_at/);
});

test("root non_owner override round-trips (title gate)", () => {
	const doc = parseDocument(fixture("mr-basic"));
	assert.equal(doc.root.nonOwner, undefined);
	doc.root.nonOwner = true;
	const out = serializeDocument(doc);
	const rootLine = out.split("\n").find((l) => l.startsWith("<gitlab-mr ")) ?? "";
	assert.match(rootLine, /non_owner="true">$/);
	const reparsed = parseDocument(out);
	assert.equal(reparsed.root.nonOwner, true);
	assert.equal(serializeDocument(reparsed), out);
});
