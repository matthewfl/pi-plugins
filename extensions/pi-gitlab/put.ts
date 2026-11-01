/**
 * file + server → action list → validate → execute (plan §4.3, §7).
 * Pi-free; the review-gate dialog and tool wiring live in index.ts.
 */

import { promises as fs } from "node:fs";
import { bypassesSignature } from "./auth.ts";
import type { DiffRefs, GitLabClient, GitLabError } from "./client.ts";
import { computeCommentableLines, type ItemSnapshot } from "./fetch.ts";
import {
	type CommentEl,
	type DescriptionEl,
	type Document,
	findConflictMarkers,
	isDraftComment,
	isDraftThread,
	type ThreadEl,
	threadComments,
} from "./format.ts";
import type { GitLabItemRef } from "./url.ts";

// ─── Types ───────────────────────────────────────────────────────────

export type PutMode = "dry_run" | "submit" | "submit_bypass_user_review";

export interface PositionSpec {
	file: string;
	line: number;
	side: "new" | "old";
}

export type Action =
	| { type: "reply"; discussionId: string; body: string; bypassSignature: boolean; source: CommentEl }
	| { type: "new_discussion"; body: string; position?: PositionSpec; bypassSignature: boolean; source: ThreadEl }
	| { type: "resolve"; discussionId: string; resolved: boolean; source: ThreadEl }
	| { type: "update_title"; title: string; nonOwner: boolean }
	| { type: "update_description"; body: string; nonOwner: boolean; source: DescriptionEl }
	| { type: "update_note"; discussionId: string; noteId: number; body: string; bypassSignature: boolean; source: CommentEl };

export interface Issue {
	level: "error" | "warning";
	message: string;
}

export interface ComputeResult {
	actions: Action[];
	errors: Issue[];
	warnings: Issue[];
}

// ─── Action computation + validation (the §4.3 state table) ─────────

export function computeActions(
	doc: Document,
	server: ItemSnapshot,
	operatorUsername: string,
	rawFileText: string,
	bypassPatterns: RegExp[] = [],
): ComputeResult {
	const actions: Action[] = [];
	const errors: Issue[] = [];
	const warnings: Issue[] = [];

	// conflict-marker guard (plan §7): any leftover git marker line blocks everything
	const markers = findConflictMarkers(rawFileText);
	if (markers.length) {
		errors.push({
			level: "error",
			message: `line ${markers[0].line}: unresolved merge conflict marker "${markers[0].marker}" — resolve conflicts in the file first, then resubmit`,
		});
		return { actions, errors, warnings };
	}

	// title edit (root tag attribute) — mirrors the description gate
	const localTitle = doc.root.title.trim();
	if (localTitle !== (server.title ?? "").trim()) {
		if (!localTitle) {
			errors.push({ level: "error", message: "title attribute is empty — restore it or stage a real title" });
		} else if (!doc.root.nonOwner && server.authorUsername !== operatorUsername) {
			errors.push({
				level: "error",
				message: `title changed but the item author is @${server.authorUsername} (you are @${operatorUsername}) — add non_owner="true" to the root tag to override`,
			});
		} else {
			actions.push({ type: "update_title", title: localTitle, nonOwner: !!doc.root.nonOwner });
		}
	}

	const serverDiscussions = new Map(server.discussions.map((d) => [d.id, d]));
	const commentable = computeCommentableLines(server.diffs);

	for (const block of doc.blocks) {
		if (block.type === "description") {
			const normLocal = block.body.replace(/\s+$/, "");
			const normServer = (server.description ?? "").replace(/\s+$/, "");
			if (normLocal !== normServer) {
				const nonOwner = block.nonOwner;
				if (!nonOwner && server.authorUsername !== operatorUsername) {
					errors.push({
						level: "error",
						message: `<description> changed but the item author is @${server.authorUsername} (you are @${operatorUsername}) — add non_owner="true" to the <description> tag to override`,
					});
					continue;
				}
				actions.push({ type: "update_description", body: normLocal, nonOwner, source: block });
			}
			continue;
		}
		if (block.type !== "thread") continue;
		const thread = block;
		const comments = threadComments(thread);

		if (isDraftThread(thread)) {
			// staged new thread (plan §4.3 rows 2–3)
			const drafts = comments.filter(isDraftComment);
			const published = comments.filter((c) => !isDraftComment(c));
			for (const p of published) {
				if (p.id !== "unset") {
					errors.push({ level: "error", message: `draft thread contains a published comment (id=${p.id}) — a new thread must contain only drafts` });
				}
			}
			const first = drafts[0];
			if (!first) {
				errors.push({ level: "error", message: "draft thread has no <comment> body" });
				continue;
			}
			if (!first.body.trim()) {
				errors.push({ level: "error", message: "draft comment body is empty" });
				continue;
			}
			let position: PositionSpec | undefined;
			if (thread.file !== undefined || thread.line !== undefined) {
				if (server.ref.kind === "issue") {
					errors.push({ level: "error", message: "code comments are not possible on issues (no diff)" });
					continue;
				}
				if (thread.file === undefined || thread.line === undefined) {
					errors.push({ level: "error", message: "code-comment thread needs both file and line attributes" });
					continue;
				}
				const side = thread.side ?? "new";
				const key = `${side}:${thread.file}:${thread.line}`;
				if (!commentable.has(key)) {
					errors.push({
						level: "error",
						message: `anchor ${thread.file}:${thread.line} (${side}) is not a commentable line in the current diff — re-fetch and move the comment`,
					});
					continue;
				}
				position = { file: thread.file, line: thread.line, side };
			}
			actions.push({
				type: "new_discussion",
				body: first.body,
				position,
				bypassSignature: bypassesSignature(first.body, bypassPatterns),
				source: thread,
			});
			continue;
		}

		// published thread
		const serverThread = serverDiscussions.get(thread.id);
		if (!serverThread) {
			errors.push({ level: "error", message: `thread ${thread.id.slice(0, 12)}… no longer exists on the server — re-run gitlab_fetch` });
			continue;
		}
		const serverNotesById = new Map(serverThread.notes.map((n) => [String(n.id), n]));

		for (const c of comments) {
			if (isDraftComment(c)) {
				if (c.id !== "unset") {
					errors.push({ level: "error", message: `draft comment in thread ${thread.id.slice(0, 12)}… has a server id (${c.id}) — drafts must use id="unset"` });
					continue;
				}
				if (!c.body.trim()) {
					errors.push({ level: "error", message: `empty draft comment in thread ${thread.id.slice(0, 12)}…` });
					continue;
				}
				actions.push({
					type: "reply",
					discussionId: thread.id,
					body: c.body,
					bypassSignature: bypassesSignature(c.body, bypassPatterns),
					source: c,
				});
				// duplicate guard (plan §7 warning): newest published note already from us
				const publishedNotes = serverThread.notes.filter((n) => !n.system);
				const newest = publishedNotes[publishedNotes.length - 1];
				if (newest) {
					const fromUs = newest.author.username === operatorUsername;
					if (fromUs) {
						warnings.push({
							level: "warning",
							message: `reply staged in thread ${thread.id.slice(0, 12)}… whose newest note is already from @${operatorUsername} — possible duplicate`,
						});
					}
				}
				continue;
			}
			// published comment — edited locally?
			const serverNote = serverNotesById.get(c.id);
			if (!serverNote) {
				errors.push({ level: "error", message: `note ${c.id} no longer exists on the server (deleted?) — re-run gitlab_fetch` });
				continue;
			}
			const normLocal = c.body.replace(/\s+$/, "");
			const normServer = (serverNote.body ?? "").replace(/\s+$/, "");
			if (normLocal !== normServer) {
				if (!c.updateExisting) {
					errors.push({
						level: "error",
						message: `published comment ${c.id} was edited locally — editing published comments requires update_existing_comment="true" on the <comment> tag`,
					});
					continue;
				}
				actions.push({
					type: "update_note",
					discussionId: thread.id,
					noteId: Number(c.id),
					body: normLocal,
					bypassSignature: bypassesSignature(normLocal, bypassPatterns),
					source: c,
				});
			}
		}

		// resolve flips (server computed the same way the renderer does)
		if (thread.resolved !== undefined) {
			if (server.ref.kind === "issue") {
				errors.push({ level: "error", message: `thread ${thread.id.slice(0, 12)}… carries resolved= but issues have no resolvable threads` });
				continue;
			}
			const serverResolved = serverThread.notes.every((n) => !n.resolvable || n.resolved);
			if (thread.resolved !== serverResolved) {
				actions.push({ type: "resolve", discussionId: thread.id, resolved: thread.resolved, source: thread });
			}
		}
	}

	return { actions, errors, warnings };
}

// ─── Stale-baseline guard (mode-aware; plan §7) ─────────────────────

export function staleBaselineIssue(doc: Document, server: ItemSnapshot, mode: PutMode): Issue | null {
	if (doc.root.fetchedAt === server.serverUpdatedAt) return null;
	const msg = `the item changed on the server since this file's snapshot (file: ${doc.root.fetchedAt}, server: ${server.serverUpdatedAt}) — re-run gitlab_fetch (the merge preserves staged edits), review, then resubmit`;
	return mode === "dry_run"
		? { level: "warning", message: msg }
		: { level: "error", message: msg };
}

// ─── Signature wrapping (plan §8) ────────────────────────────────────

export function wrapForPost(signatureHeader: string, body: string): string {
	return `${signatureHeader}\n\n${body}`;
}
export function ensureSignature(signatureHeader: string, body: string): string {
	return body.includes(signatureHeader) ? body : wrapForPost(signatureHeader, body);
}

/** position object for createDiscussion (GitLab wants both path fields). */
export function buildPositionBody(spec: PositionSpec, refs: DiffRefs): Record<string, unknown> {
	return {
		position_type: "text",
		base_sha: refs.base_sha,
		start_sha: refs.start_sha,
		head_sha: refs.head_sha,
		old_path: spec.file,
		new_path: spec.file,
		...(spec.side === "new" ? { new_line: spec.line } : { old_line: spec.line }),
	};
}

// ─── Executor (sequential, paced; plan §7) ───────────────────────────

export interface ExecOutcome {
	action: Action;
	ok: boolean;
	error?: string;
	/** true when a preceding auth/pace failure aborted the run */
	notAttempted?: boolean;
	/** exact body posted to GitLab (with signature/footer applied), for file reconciliation */
	postedBody?: string;
	/** server note id of the posted note — recorded so unsigned (whitelist) posts still mark via_pi */
	postedNoteId?: number;
}

export interface ExecOptions {
	sleep?: (ms: number) => Promise<void>;
	paceMs?: number;
	signatureHeader: string;
	operatorUsername: string;
	diffRefs?: DiffRefs;
}

const ABORT_STATUSES = new Set([401, 403, 429]);

export async function executeActions(
	client: GitLabClient,
	ref: GitLabItemRef,
	actions: Action[],
	opts: ExecOptions,
): Promise<ExecOutcome[]> {
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const pace = opts.paceMs ?? 300;
	const outcomes: ExecOutcome[] = [];
	let aborted = false;

	for (const action of actions) {
		if (aborted) {
			outcomes.push({ action, ok: false, notAttempted: true, error: "not attempted (run aborted)" });
			continue;
		}
		let postedBody: string | undefined;
		let postedNoteId: number | undefined;
		try {
			switch (action.type) {
				case "reply":
					postedBody = action.bypassSignature ? action.body.trim() : wrapForPost(opts.signatureHeader, action.body);
					postedNoteId = (
						await client.addNote(ref.projectPath, ref.kind, ref.iid, action.discussionId, postedBody)
					)?.id;
					break;
				case "new_discussion": {
					postedBody = action.bypassSignature ? action.body.trim() : wrapForPost(opts.signatureHeader, action.body);
					const disc = await client.createDiscussion(
						ref.projectPath, ref.kind, ref.iid,
						postedBody,
						action.position
							? (buildPositionBody(action.position, opts.diffRefs ?? { base_sha: "", start_sha: "", head_sha: "" }) as never)
							: undefined,
					);
					postedNoteId = Array.isArray(disc?.notes) ? disc.notes[0]?.id : undefined;
					break;
				}
				case "resolve": {
					if (ref.kind !== "mr") throw new Error("issues have no resolvable threads");
					await client.resolveDiscussion(ref.projectPath, ref.iid, action.discussionId, action.resolved);
					break;
				}
				case "update_title":
				await client.updateTitle(ref.projectPath, ref.kind, ref.iid, action.title);
				break;
			case "update_description": {
					let body = action.body;
					if (action.nonOwner) {
						body = `${body}\n\n_Description updated via pi-gitlab (AI agent) acting for @${opts.operatorUsername}._`;
					}
					postedBody = body;
					await client.updateDescription(ref.projectPath, ref.kind, ref.iid, body);
					break;
				}
				case "update_note":
					postedBody = action.bypassSignature ? action.body.trim() : ensureSignature(opts.signatureHeader, action.body);
					postedNoteId = (
						await client.updateNote(
							ref.projectPath, ref.kind, ref.iid, action.discussionId, action.noteId,
							postedBody,
						)
					)?.id;
					break;
			}
			outcomes.push({ action, ok: true, postedBody, postedNoteId });
		} catch (e) {
			const err = e as GitLabError;
			outcomes.push({ action, ok: false, error: err.message });
			if (ABORT_STATUSES.has(err.status)) aborted = true;
		}
		await sleep(pace);
	}
	return outcomes;
}

// ─── Post-submit file reconciliation ────────────────────────────────
// Before the post-submit re-render/merge, the on-disk file must stop
// claiming the just-posted edits as local changes: a posted draft removed
// here reappears via the fresh server render as a published note (anything
// left staged would be re-applied by the 3-way merge and re-posted by the
// next put — the double-post guard). For body-replacing edits
// (update_note / update_description) the local body is synced to the exact
// posted body so both sides of the merge agree.

const OPEN_COMMENT = /^<comment\s/;
const OPEN_THREAD = /^<discussion_thread\s/;
const OPEN_DESC = /^<description[\s>]/;

interface Block {
	start: number;
	end: number; // inclusive, line of the close tag
	open: string;
}

function scanBlocks(lines: string[], openRe: RegExp, close: string): Block[] {
	const out: Block[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (!openRe.test(lines[i])) continue;
		for (let j = i + 1; j < lines.length; j++) {
			if (lines[j] === close) {
				out.push({ start: i, end: j, open: lines[i] });
				i = j;
				break;
			}
		}
	}
	return out;
}

const blockBody = (lines: string[], b: Block): string => lines.slice(b.start + 1, b.end).join("\n").replace(/\s+$/, "");

function removeBlock(lines: string[], b: Block): string[] {
	const next = [...lines.slice(0, b.start), ...lines.slice(b.end + 1)];
	// drop one separator blank line if we would leave two in a row (or a trailing one)
	if (next[b.start] === "" && (next[b.start - 1] === "" || next[b.start - 1] === undefined)) next.splice(b.start, 1);
	else if (next[b.start] === "" && next[b.start - 1]?.startsWith("</")) next.splice(b.start, 1);
	return next;
}

/** Remove one staged draft comment matching body, optionally inside a given published thread. */
function removeDraftComment(lines: string[], body: string, discussionId?: string): string[] {
	const comments = scanBlocks(lines, OPEN_COMMENT, "</comment>");
	const threads = scanBlocks(lines, OPEN_THREAD, "</discussion_thread>");
	for (const c of comments) {
		if (!c.open.includes('visible="unpublished"')) continue;
		if (blockBody(lines, c) !== body.replace(/\s+$/, "")) continue;
		if (discussionId) {
			const parent = threads.find((t) => t.start < c.start && t.end > c.end);
			if (!parent || !parent.open.includes(`id="${discussionId}"`)) continue;
		}
		return removeBlock(lines, c);
	}
	return lines;
}

/** Remove one whole staged new-discussion thread containing a draft comment with the given body. */
function removeDraftThread(lines: string[], body: string): string[] {
	const threads = scanBlocks(lines, OPEN_THREAD, "</discussion_thread>");
	for (const t of threads) {
		if (!t.open.includes('visible="unpublished"')) continue;
		const inner = scanBlocks(lines.slice(t.start + 1, t.end), OPEN_COMMENT, "</comment>");
		const match = inner.some((c) =>
			c.open.includes('visible="unpublished"') &&
			lines.slice(t.start + 1 + c.start + 1, t.start + 1 + c.end).join("\n").replace(/\s+$/, "") === body.replace(/\s+$/, ""));
		if (match) return removeBlock(lines, t);
	}
	return lines;
}

function replaceBody(lines: string[], b: Block, newBody: string): string[] {
	return [...lines.slice(0, b.start + 1), ...newBody.split("\n"), ...lines.slice(b.end)];
}

/**
 * Pure text transform: drop published-away staged drafts and sync edited
 * bodies with the exact posted text. Failed/not-attempted actions are left
 * untouched (they stay staged for annotation + resubmit).
 */
export function reconcileFileText(text: string, outcomes: ExecOutcome[]): string {
	let lines = text.split("\n");
	for (const o of outcomes) {
		if (!o.ok) continue;
		const a = o.action;
		if (a.type === "reply") {
			lines = removeDraftComment(lines, a.body, a.discussionId);
		} else if (a.type === "new_discussion") {
			lines = removeDraftThread(lines, a.body);
		} else if (a.type === "update_description" && o.postedBody !== undefined) {
			const desc = scanBlocks(lines, OPEN_DESC, "</description>")[0];
			if (desc) lines = replaceBody(lines, desc, o.postedBody);
		} else if (a.type === "update_note" && o.postedBody !== undefined) {
			const c = scanBlocks(lines, OPEN_COMMENT, "</comment>")
				.find((c) => c.open.includes(`id="${a.noteId}"`) && !c.open.includes('visible="unpublished"'));
			if (c) {
				// the one-shot edit flag is consumed by the successful edit — strip
				// it so the next submit doesn't silently re-run the same update
				lines[c.start] = c.open.replace(/\s*update_existing_comment="true"/, "");
				lines = replaceBody(lines, c, o.postedBody);
			}
		}
	}
	return lines.join("\n");
}

/** File wrapper around reconcileFileText; returns true when the file changed. */
export async function reconcileAfterSubmit(filePath: string, outcomes: ExecOutcome[]): Promise<boolean> {
	if (!outcomes.some((o) => o.ok)) return false;
	const text = await fs.readFile(filePath, "utf8");
	const reconciled = reconcileFileText(text, outcomes);
	if (reconciled === text) return false;
	await fs.writeFile(filePath, reconciled);
	return true;
}

// ─── Failure annotations (plan §4.3 inline ✗) ───────────────────────

/**
 * Insert `<!-- put FAIL: reason -->` above each failed draft in the merged
 * file (matched by exact draft-body text). Returns number annotated.
 */
export async function annotateFailuresInFile(
	filePath: string,
	failures: { body: string; error: string }[],
): Promise<number> {
	if (!failures.length) return 0;
	const text = await fs.readFile(filePath, "utf8");
	const lines = text.split("\n");
	let annotated = 0;
	for (const f of failures) {
		const bodyFirstLine = f.body.trim().split("\n")[0];
		if (!bodyFirstLine) continue;
		// find the draft comment whose body starts with this exact first line
		for (let i = 0; i < lines.length; i++) {
			if (!lines[i].startsWith("<comment ") || !lines[i].includes('visible="unpublished"')) continue;
			// body starts next line
			if (lines[i + 1] === bodyFirstLine) {
				const reason = f.error.replace(/-->/g, "—>").slice(0, 160);
				lines.splice(i, 0, `<!-- put FAIL: ${reason} -->`);
				annotated++;
				break;
			}
		}
	}
	await fs.writeFile(filePath, lines.join("\n"), "utf8");
	return annotated;
}

// ─── Tool-facing summary helpers ─────────────────────────────────────

export function describeAction(a: Action, idx: number): string {
	const n = `${idx + 1}.`;
	const sigNote = "bypassSignature" in a && a.bypassSignature ? " [unsigned — whitelist match, no signature header]" : "";
	switch (a.type) {
		case "reply":
			return `${n} reply in thread ${a.discussionId.slice(0, 8)}…${sigNote} — ${firstLine(a.body)}`;
		case "new_discussion":
			return a.position
				? `${n} new code comment ${a.position.file}:${a.position.line} (${a.position.side})${sigNote} — ${firstLine(a.body)}`
				: `${n} new top-level comment${sigNote} — ${firstLine(a.body)}`;
		case "resolve":
			return `${n} ${a.resolved ? "resolve" : "unresolve"} thread ${a.discussionId.slice(0, 8)}…`;
		case "update_description":
			return `${n} update ${a.nonOwner ? "NON-OWNER " : ""}description — ${firstLine(a.body)}`;
		case "update_title":
			return `${n} update ${a.nonOwner ? "NON-OWNER " : ""}title — ${firstLine(a.title)}`;
		case "update_note":
			return `${n} EDIT published note ${a.noteId} — ${firstLine(a.body)}`;
	}
}

function firstLine(body: string): string {
	const l = body.trim().split("\n")[0] ?? "";
	return l.length > 72 ? l.slice(0, 69) + "…" : l;
}
