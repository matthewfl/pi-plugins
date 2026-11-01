/**
 * Server → file: snapshot building, rendering, git merge-file three-way
 * (plan §5–§6). Pi-free and unit-testable: node:child_process git shellouts,
 * all paths injectable.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Discussion, GitLabClient, Note, NotePosition } from "./client.ts";
import {
	type CodeContextEl,
	type CommentEl,
	type Document,
	type HtmlComment,
	parseDocument,
	serializeDocument,
	type ThreadEl,
} from "./format.ts";
import {
	basePath,
	diffPathFor,
	itemFilePath,
	prevPath,
	statePath,
	storeDir,
	type ItemState,
} from "./paths.ts";
import type { GitLabItemRef } from "./url.ts";

export interface GitRun {
	(args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** Default git runner — resolves with the exit code, never throws on != 0. */
export const runGit: GitRun = (args, cwd) =>
	new Promise((resolve, reject) => {
		execFile(
			"git",
			args,
			{ cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
			(err, stdout, stderr) => {
				if (err && typeof err.code === "number") {
					resolve({ code: err.code, stdout: stdout ?? "", stderr: stderr ?? "" });
				} else if (err) {
					reject(err);
				} else {
					resolve({ code: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
				}
			},
		);
	});

// ─── Snapshot (what the server knows about an item) ─────────────────

export interface ItemSnapshot {
	ref: GitLabItemRef;
	title: string;
	description: string;
	state: string;
	draft?: boolean;
	pipeline?: string;
	headSha?: string;
	diffRefs?: { base_sha: string; start_sha: string; head_sha: string };
	authorUsername: string;
	serverUpdatedAt: string;
	discussions: Discussion[];
	codeContexts: Map<string, string[]>; // discussionId → rendered <code_context> lines
	/** per-file diffs (MR only) — kept for put's anchor validation */
	diffs: { old_path: string; new_path: string; diff: string }[];
}

export async function buildSnapshot(
	ref: GitLabItemRef,
	client: GitLabClient,
	fetchedAt = new Date().toISOString(),
): Promise<ItemSnapshot> {
	const discussions = await client.listDiscussions(ref.projectPath, ref.kind, ref.iid);
	if (ref.kind === "mr") {
		const [mr, diffs] = await Promise.all([
			client.getMergeRequest(ref.projectPath, ref.iid),
			client.getMrDiffs(ref.projectPath, ref.iid),
		]);
		const codeContexts = new Map<string, string[]>();
		for (const d of discussions) {
			const note = d.notes.find((n) => n.position);
			if (note?.position) {
				const lines = computeCodeContextLines(diffs, note.position);
				if (lines) codeContexts.set(d.id, lines);
			}
		}
		return {
			ref,
			title: mr.title,
			description: mr.description ?? "",
			state: mr.state,
			draft: mr.draft,
			pipeline: mr.head_pipeline?.status ?? undefined,
			headSha: mr.sha,
			diffRefs: mr.diff_refs,
			authorUsername: mr.author.username,
			serverUpdatedAt: mr.updated_at,
			discussions,
			codeContexts,
			diffs,
		};
	}
	const issue = await client.getIssue(ref.projectPath, ref.iid);
	return {
		ref,
		title: issue.title,
		description: issue.description ?? "",
		state: issue.state,
		authorUsername: issue.author.username,
		serverUpdatedAt: issue.updated_at,
		discussions,
		codeContexts: new Map(),
		diffs: [],
	};
}

// ─── <code_context> computation ──────────────────────────────────────

interface HunkLine {
	content: string;
	oldLine: number | null;
	newLine: number | null;
}

function parseHunks(diff: string): HunkLine[][] {
	const hunks: HunkLine[][] = [];
	let cur: HunkLine[] | null = null;
	let oldN = 0;
	let newN = 0;
	for (const ln of diff.split("\n")) {
		const h = ln.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (h) {
			cur = [];
			hunks.push(cur);
			oldN = Number(h[1]);
			newN = Number(h[2]);
			continue;
		}
		if (!cur) continue;
		if (ln.startsWith("+")) {
			cur.push({ content: ln.slice(1), oldLine: null, newLine: newN++ });
		} else if (ln.startsWith("-")) {
			cur.push({ content: ln.slice(1), oldLine: oldN++, newLine: null });
		} else if (ln.startsWith("\\")) {
			// "\ No newline at end of file" — ignore
		} else {
			cur.push({ content: ln.slice(1), oldLine: oldN++, newLine: newN++ });
		}
	}
	return hunks;
}

/** Set of `side:path:line` keys for lines a diff comment can anchor to (plan §7). */
export function computeCommentableLines(
	diffs: { old_path: string; new_path: string; diff: string }[],
): Set<string> {
	const out = new Set<string>();
	for (const f of diffs) {
		for (const hunk of parseHunks(f.diff)) {
			for (const l of hunk) {
				if (l.newLine != null) out.add(`new:${f.new_path}:${l.newLine}`);
				if (l.oldLine != null) out.add(`old:${f.old_path}:${l.oldLine}`);
			}
		}
	}
	return out;
}

const LANG_BY_EXT: Record<string, string> = {
	ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", py: "py", go: "go",
	rb: "rb", rs: "rust", java: "java", kt: "kotlin", c: "c", h: "c", cpp: "cpp",
	cc: "cpp", cs: "csharp", sh: "bash", yml: "yaml", yaml: "yaml", json: "json",
	md: "md", css: "css", scss: "scss", html: "html", vue: "vue", sql: "sql",
};

export function computeCodeContextLines(
	diffs: { old_path: string; new_path: string; diff: string }[],
	position: NotePosition,
): string[] | undefined {
	const useNew = position.new_line != null;
	const file = diffs.find(
		(d) => (useNew ? d.new_path : d.old_path) === (useNew ? position.new_path : position.old_path),
	);
	if (!file) return undefined;
	const target = useNew ? position.new_line! : position.old_line!;
	for (const hunk of parseHunks(file.diff)) {
		const idx = hunk.findIndex((l) => (useNew ? l.newLine : l.oldLine) === target);
		if (idx === -1) continue;
		// window measured in *displayable* lines (removed lines don't show on the new side)
		const displayable = (l: HunkLine) => (useNew ? l.newLine : l.oldLine) != null;
		let from = idx;
		for (let want = 1; from > 0 && want > 0; ) {
			from--;
			if (displayable(hunk[from])) want--;
		}
		let to = idx;
		for (let want = 2; to < hunk.length - 1 && want > 0; ) {
			to++;
			if (displayable(hunk[to])) want--;
		}
		const ext = file.new_path.split(".").pop() ?? "";
		const out: string[] = [`\`\`\`${LANG_BY_EXT[ext] ?? ""}`];
		for (let i = from; i <= to; i++) {
			const l = hunk[i];
			const n = useNew ? l.newLine : l.oldLine;
			if (n == null) continue; // skip removed lines when displaying the new side (and vice versa)
			const mark = n === target ? "   // ← commented line" : "";
			out.push(`${n}  ${l.content}${mark}`);
		}
		out.push("```");
		return out;
	}
	return undefined;
}

// ─── Rendering (server snapshot → Document) ──────────────────────────

export interface RenderOptions {
	operatorUsername: string;
	signatureHeader: string;
	/** note ids we posted (persisted in state.json) — marks them via_pi even
	 * when the unsigned-triggers whitelist meant no signature header. */
	viaPiNoteIds?: number[];
}

const REPLY_TEMPLATE = `<!-- template — copy into a real <comment> block to reply:
<comment author="pi" id="unset" visible="unpublished">
…reply…
</comment>
-->`;

export function builtInPreamble(): HtmlComment {
	return {
		type: "html",
		raw: [
			"<!-- gitlab file — staged edits: add <comment> blocks with visible=\"unpublished\", flip",
			"     resolved attributes, or edit the <description> body; then run gitlab_put.",
			"     HTML comments like this one are ignored by the parser.",
			"-->",
		],
	};
}

function endTemplates(kind: "mr" | "issue"): HtmlComment {
	const lines = [
		"<!-- new top-level thread template:",
		'<discussion_thread id="unset" visible="unpublished">',
		'<comment author="pi" id="unset" visible="unpublished">',
		"…new standalone comment…",
		"</comment>",
		"</discussion_thread>",
	];
	if (kind === "mr") {
		lines.push(
			"",
			"new code-commented thread template:",
			'<discussion_thread id="unset" file="path/from/diff" line="123" side="new" visible="unpublished">',
			'<comment author="pi" id="unset" visible="unpublished">',
			"…review comment…",
			"</comment>",
			"</discussion_thread>",
		);
	}
	lines.push("-->");
	return { type: "html", raw: lines };
}

function noteToComment(note: Note, opts: RenderOptions): CommentEl {
	return {
		type: "comment",
		author: `@${note.author.username}`,
		id: String(note.id),
		visible: "published",
		fromOperator: note.author.username === opts.operatorUsername,
		viaPi: note.body.startsWith(opts.signatureHeader) || (opts.viaPiNoteIds?.includes(note.id) ?? false),
		updateExisting: false,
		createdAt: note.created_at,
		body: note.body,
	};
}

export function buildDocument(snapshot: ItemSnapshot, opts: RenderOptions): Document {
	const { ref } = snapshot;
	const threads: ThreadEl[] = [];
	for (const d of snapshot.discussions) {
		const notes = d.notes.filter((n) => !n.system);
		if (notes.length === 0) continue;
		const firstWithPos = notes.find((n) => n.position);
		const resolvable = notes.some((n) => n.resolvable);
		const t: ThreadEl = {
			type: "thread",
			id: d.id,
			visible: "published",
			children: [],
		};
		if (resolvable && ref.kind === "mr") t.resolved = notes.every((n) => !n.resolvable || n.resolved);
		if (firstWithPos?.position) {
			const p = firstWithPos.position;
			const useNew = p.new_line != null;
			t.file = useNew ? p.new_path : p.old_path;
			t.line = useNew ? p.new_line! : p.old_line!;
			t.side = useNew ? "new" : "old";
		}
		const ctx = snapshot.codeContexts.get(d.id);
		if (ctx) t.children.push({ type: "code_context", lines: ctx } satisfies CodeContextEl);
		for (const n of notes) t.children.push(noteToComment(n, opts));
		t.children.push({
			type: "html",
			raw: REPLY_TEMPLATE.split("\n"),
		});
		threads.push(t);
	}
	const doc: Document = {
		preamble: [builtInPreamble()],
		root: {
			kind: ref.kind,
			source: ref.url,
			iid: ref.iid,
			title: snapshot.title,
			state: snapshot.state,
			author: `@${snapshot.authorUsername}`,
			operatorAuthor: snapshot.authorUsername === opts.operatorUsername,
			fetchedAt: snapshot.serverUpdatedAt,
		},
		blocks: [
			{
				type: "description",
				nonOwner: false,
				body: snapshot.description,
			},
			...threads,
			endTemplates(ref.kind),
		],
	};
	if (snapshot.state && ref.kind === "mr") {
		doc.root.draft = snapshot.draft;
		if (snapshot.headSha !== undefined) doc.root.headSha = snapshot.headSha;
		if (snapshot.pipeline !== undefined) doc.root.pipeline = snapshot.pipeline;
	}
	return doc;
}

// ─── applyFetch: merge + sidecars + .diff (plan §5.1, §6) ───────────

export interface ApplyResult {
	filePath: string;
	diffPath: string;
	firstFetch: boolean;
	conflicted: boolean;
	serverChanged: boolean;
}

async function atomicWrite(file: string, content: string): Promise<void> {
	const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(tmp, content, "utf8");
	await fs.rename(tmp, file);
}

async function readIfExists(file: string): Promise<string | null> {
	try {
		return await fs.readFile(file, "utf8");
	} catch {
		return null;
	}
}

function stateFor(snapshot: ItemSnapshot, viaPiNoteIds: number[]): ItemState {
	return {
		fetchedAt: snapshot.serverUpdatedAt,
		serverUpdatedAt: snapshot.serverUpdatedAt,
		sourceUrl: snapshot.ref.url,
		headSha: snapshot.headSha,
		diffRefs: snapshot.diffRefs,
		...(viaPiNoteIds.length ? { viaPiNoteIds } : {}),
	};
}

/** state.json sidecar, or null if none yet. */
export async function readState(ref: GitLabItemRef, root: string): Promise<ItemState | null> {
	try {
		return JSON.parse(await fs.readFile(statePath(ref, root), "utf8")) as ItemState;
	} catch {
		return null;
	}
}

/**
 * Merge the fresh snapshot into the item file (or create it on first fetch).
 * Always: .store/base = the pure server render; prev = file-before-write;
 * .diff = git diff --no-index prev→file. (plan §5 invariant)
 */
function sentinelRootLine(text: string): string {
	return text.replace(/^<(gitlab-mr|gitlab-issue)\s[^>]*>$/m, ROOT_SENTINEL);
}

/** Put the resolved root line back where the sentinel stood. */
function spliceRootLine(merged: string, rootBlock: string): string {
	return merged.replace(ROOT_SENTINEL, rootBlock);
}

const ROOT_LINE = /^<(gitlab-mr|gitlab-issue)\s[^>]*>$/;

/**
 * The root tag packs every item attribute onto ONE line, so a line-based
 * three-way merge cannot reconcile an agent-edited `title` with routine
 * server churn on the same line (`fetched_at` on every fetch, `state`,
 * `head_sha`). Normalize the staged copy before merging: give it the
 * SERVER's root line and re-apply only the attributes an agent may stage
 * (`title`, `non_owner`) that the server did NOT also change. Everything
 * else on that line is server-owned.
 *
 * Conflict policy: if BOTH sides changed the same attribute (someone renamed
 * the item in the web UI while a rename was staged locally), the staged text
 * is returned untouched so `git merge-file` emits real `<<<<<<<` markers
 * (plan §5) — the agent repairs them and `put` refuses to submit until it
 * does. Silently preferring the local value would drop the other rename with
 * no signal, since `fetched_at` is server-owned and the stale-baseline guard
 * cannot see it.
 */
export function reconcileRootLine(staged: string, base: string, server: string): string {
	const stagedRoot = staged.split("\n").find((l) => ROOT_LINE.test(l));
	const baseRoot = base.split("\n").find((l) => ROOT_LINE.test(l));
	const serverRoot = server.split("\n").find((l) => ROOT_LINE.test(l));
	if (!stagedRoot || !baseRoot || !serverRoot) return staged;
	const attrOf = (line: string, key: string): string | undefined =>
		line.match(new RegExp(`\\s${key}="([^"]*)"`))?.[1];
	let merged = serverRoot;
	for (const key of ["title", "non_owner"]) {
		const stagedVal = attrOf(stagedRoot, key);
		if (stagedVal === undefined) continue;
		const baseVal = attrOf(baseRoot, key);
		if (stagedVal === baseVal) continue; // agent did not change it — server owns it
		const serverVal = attrOf(serverRoot, key);
		if (serverVal !== baseVal && serverVal !== undefined) return staged; // both sides changed → markers
		if (serverVal === undefined) {
			// server render legitimately lacks the attr (non_owner is only
			// emitted when set) — carry the staged value at its canonical
			// position (plan §4.2 attribute order: appended last)
			merged = merged.replace(/\s*>$/, ` ${key}="${stagedVal}">`);
			continue;
		}
		merged = merged.replace(
			new RegExp(`(\\s${key}=")[^"]*(")`),
			(_m, pre: string, post: string) => `${pre}${stagedVal}${post}`,
		);
	}
	if (merged === stagedRoot) return staged;
	return staged.replace(stagedRoot, merged);
}

/**
 * The root tag packs every item attribute onto ONE line, so a line-based
 * three-way merge cannot reconcile an agent-edited `title` with routine
 * server churn on the same line (`fetched_at` on every fetch, `state`,
 * `head_sha`) — both sides modified that line, and `git merge-file` reports
 * a conflict for a line both sides touched even when the changes are
 * compatible attributes.
 *
 * So the root line is excluded from the text merge entirely: all three merge
 * inputs carry the same sentinel line in its place, and the resolved root
 * line is spliced back afterwards from the attribute-level policy below.
 */
export const ROOT_SENTINEL = "<!--pi-gitlab-root-line-->";

export function rootLineOf(text: string): string | null {
	return text.split("\n").find((l) => ROOT_LINE.test(l)) ?? null;
}

/**
 * Attribute-level root-line merge (mirrors the conflict rule in plan §5):
 *   - the agent changed only `title`/`non_owner` → server's line + staged value
 *   - the server changed the same attribute too (someone renamed it in the web
 *     UI while a rename was staged) → synthesize git markers so it is
 *     SURFACED: put refuses to submit until the agent repairs it. Silently
 *     preferring either side would drop the other change with no signal, and
 *     the stale-baseline guard cannot see it (`fetched_at` is server-owned).
 *   - everything else on the line is server-owned.
 */
export function mergeRootLine(stagedText: string, baseText: string, serverText: string): {
	block: string;
	conflicted: boolean;
} {
	const stagedRoot = rootLineOf(stagedText);
	const baseRoot = rootLineOf(baseText);
	const serverRoot = rootLineOf(serverText);
	if (!stagedRoot || !baseRoot || !serverRoot) {
		return { block: serverRoot ?? stagedRoot ?? "", conflicted: false };
	}
	const attrOf = (line: string, key: string): string | undefined =>
		line.match(new RegExp(`\\s${key}="([^"]*)"`))?.[1];
	const agentVariant = (() => {
		let line = serverRoot;
		for (const key of ["title", "non_owner"]) {
			const stagedVal = attrOf(stagedRoot, key);
			const baseVal = attrOf(baseRoot, key);
			if (stagedVal === undefined || stagedVal === baseVal) continue;
			const serverVal = attrOf(serverRoot, key);
			if (serverVal === undefined) {
				// attr absent server-side (non_owner is only emitted when set) —
				// append at its canonical position (plan §4.2 attribute order)
				line = line.replace(/\s*>$/, ` ${key}="${stagedVal}">`);
			} else {
				line = line.replace(
					new RegExp(`(\\s${key}=")[^"]*(")`),
					(_m, pre: string, post: string) => `${pre}${stagedVal}${post}`,
				);
			}
		}
		return line;
	})();
	const bothChanged = (["title", "non_owner"] as const).some((key) => {
		const stagedVal = attrOf(stagedRoot, key);
		if (stagedVal === undefined || stagedVal === attrOf(baseRoot, key)) return false;
		const serverVal = attrOf(serverRoot, key);
		// conflict only when the two sides picked DIFFERENT values; equal values
		// (the normal post-submit state: pi just posted the staged title) agree
		return serverVal !== undefined && serverVal !== attrOf(baseRoot, key) && serverVal !== stagedVal;
	});
	if (bothChanged) {
		return {
			block: `<<<<<<< staged\n${agentVariant}\n=======\n${serverRoot}\n>>>>>>> server`,
			conflicted: true,
		};
	}
	return { block: agentVariant, conflicted: false };
}

export async function applySnapshot(
	snapshot: ItemSnapshot,
	opts: RenderOptions,
	root: string,
	git: GitRun = runGit,
	extraViaIds: number[] = [],
): Promise<ApplyResult> {
	const filePath = itemFilePath(snapshot.ref, root);
	const diffPath = diffPathFor(filePath);
	const base = basePath(snapshot.ref, root);
	const prev = prevPath(snapshot.ref, root);
	const state = statePath(snapshot.ref, root);
	// merge recorded ids (prior submits + this batch's) so unsigned whitelist
	// posts still render via_pi
	const prior = opts.viaPiNoteIds ?? (await readState(snapshot.ref, root))?.viaPiNoteIds ?? [];
	const viaIds = [...new Set([...prior, ...extraViaIds])];
	const serverRender = serializeDocument(buildDocument(snapshot, { ...opts, viaPiNoteIds: viaIds }));
	await fs.mkdir(storeDir(snapshot.ref, root), { recursive: true });

	const existing = await readIfExists(filePath);
	const firstFetch = existing === null || (await readIfExists(base)) === null;
	let mergedText = serverRender;
	let conflicted = false;
	let serverChanged = true;

	if (firstFetch) {
		await atomicWrite(filePath, serverRender);
 	} else {
		const oldBase = (await readIfExists(base)) ?? "";
		if (oldBase === serverRender && existing !== null) {
			serverChanged = false;
		}
		if (serverChanged) {
			// The root line is merged attribute-wise (see mergeRootLine) because
			// a line-based merge would conflict on any co-edited attribute. All
			// three inputs get the same sentinel; the resolved line is spliced in.
			const rootResolution = mergeRootLine(existing ?? serverRender, oldBase, serverRender);
			const stagedTmp = `${base}.staged-${process.pid}`;
			await fs.writeFile(stagedTmp, sentinelRootLine(existing ?? serverRender), "utf8");
			const baseTmp = `${base}.base-${process.pid}`;
			await fs.writeFile(baseTmp, sentinelRootLine(oldBase), "utf8");
			const serverSentinel = sentinelRootLine(serverRender);
			const serverSentinelTmp = `${base}.new-sentinel-${process.pid}`;
			await fs.writeFile(serverSentinelTmp, serverSentinel, "utf8");
			const res = await git(
				[
					"merge-file", "--stdout",
					"-L", "staged", "-L", "base", "-L", "server",
					stagedTmp, baseTmp, serverSentinelTmp,
				],
				undefined,
			);
			await fs.rm(stagedTmp, { force: true });
			await fs.rm(baseTmp, { force: true });
			await fs.rm(serverSentinelTmp, { force: true });
			if (res.code < 0 || res.code > 100) {
				throw new Error(`git merge-file failed (${res.code}): ${res.stderr.trim()}`);
			}
			conflicted = res.code > 0 || rootResolution.conflicted;
			mergedText = spliceRootLine(res.stdout, rootResolution.block);
			await atomicWrite(filePath, mergedText);
		} else if (existing !== serverRender) {
			// server untouched; agent may have staged edits — keep the file as-is
			mergedText = existing ?? serverRender;
		}
		// always refresh .diff against what the file used to be
	}

	const previous = firstFetch ? serverRender : (existing ?? serverRender);
	await fs.writeFile(base, serverRender, "utf8");
	await fs.writeFile(prev, firstFetch ? serverRender : previous, "utf8");
	await fs.writeFile(state, JSON.stringify(stateFor(snapshot, viaIds), null, 2) + "\n", "utf8");

	// .diff: prev → file ("No changes" marker when identical)
	const current = (await readIfExists(filePath)) ?? "";
	const prevText = await readIfExists(prev);
	if (prevText === current) {
		await fs.writeFile(diffPath, "No changes since last fetch.\n", "utf8");
	} else {
		const prevTmp = `${prev}.difftmp-${process.pid}`;
		await fs.writeFile(prevTmp, prevText ?? "", "utf8");
		const d = await git(["diff", "--no-index", "--no-color", "--", prevTmp, filePath], undefined);
		await fs.rm(prevTmp, { force: true });
		// exit 1 = differences (not an error); >1 is a real failure
		if (d.code > 1) throw new Error(`git diff --no-index failed (${d.code}): ${d.stderr.trim()}`);
		await fs.writeFile(diffPath, d.stdout || "No changes since last fetch.\n", "utf8");
	}

	return { filePath, diffPath, firstFetch, conflicted, serverChanged };
}

/** Summary line + parsed document helper shared by fetch tool & tests. */
export async function readParsed(filePath: string): Promise<Document> {
	return parseDocument(await fs.readFile(filePath, "utf8"));
}
