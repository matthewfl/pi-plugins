/**
 * The gitlab file grammar (plan §4): parser + serializer.
 *
 * Line-oriented: element tags recognized only at column 0; bodies are raw
 * markdown between open/close tag lines; `<!-- … -->` regions are skipped
 * entirely by the parser (templates and human guidance live there) and are
 * preserved verbatim so serialize(parse(x)) round-trips. Body lines that
 * Inside bodies, only lines whose tag name is one of OURS have grammar
 * meaning; any other markup-looking line (HTML blocks like a bot's
 * `<details>` block) is plain body text, verbatim.
 */

// ─── Model ───────────────────────────────────────────────────────────

export interface RootAttrs {
	kind: "mr" | "issue";
	source: string;
	iid: number;
	title: string;
	state: string;
	draft?: boolean;
	pipeline?: string;
	headSha?: string;
	author: string;
	operatorAuthor: boolean;
	fetchedAt: string;
	/** agent-added override for editing an item the operator doesn't own
	 * (gates update_title; mirrors <description non_owner="true">) */
	nonOwner?: boolean;
}

export interface CommentEl {
	type: "comment";
	author: string;
	id: string; // server note id or "unset"
	visible: "published" | "unpublished";
	fromOperator: boolean;
	viaPi: boolean;
	updateExisting: boolean;
	createdAt?: string;
	/** raw markdown body (no trailing blank lines) */
	body: string;
}

export interface CodeContextEl {
	type: "code_context";
	/** raw lines, fences included */
	lines: string[];
}

export interface HtmlComment {
	type: "html";
	/** verbatim lines from the `<!--` line through the `-->` line */
	raw: string[];
}

export type ThreadChild = CodeContextEl | CommentEl | HtmlComment;

export interface ThreadEl {
	type: "thread";
	id: string; // server discussion id or "unset"
	visible: "published" | "unpublished";
	resolved?: boolean; // omitted = not a resolvable thread
	file?: string;
	line?: number;
	side?: "new" | "old";
	children: ThreadChild[];
}

export interface DescriptionEl {
	type: "description";
	nonOwner: boolean;
	body: string;
}

export type TopBlock = HtmlComment | DescriptionEl | ThreadEl;

export interface Document {
	/** html comments appearing before the root tag */
	preamble: HtmlComment[];
	root: RootAttrs;
	blocks: TopBlock[];
}

// ─── Errors ──────────────────────────────────────────────────────────

export class FormatError extends Error {
	line: number;
	constructor(line: number, message: string) {
		super(`line ${line}: ${message}`);
		this.name = "FormatError";
		this.line = line;
	}
}

// ─── Attribute helpers ───────────────────────────────────────────────

function parseTagLine(line: string): { name: string; closing: boolean; attrs: Record<string, string> } | null {
	const m = line.match(/^<(\/?)([a-z_-]+)((?:\s+[a-z_]+="[^"]*")*)\s*>$/);
	if (!m) return null;
	const attrs: Record<string, string> = {};
	const attrRe = /([a-z_]+)="([^"]*)"/g;
	let a: RegExpExecArray | null;
	while ((a = attrRe.exec(m[3]))) attrs[a[1]] = a[2];
	return { name: m[2], closing: m[1] === "/", attrs };
}

function requireAttrs(
	line: number,
	name: string,
	attrs: Record<string, string>,
	allowed: string[],
	required: string[],
): void {
	for (const [k, v] of Object.entries(attrs)) {
		if (!allowed.includes(k)) throw new FormatError(line, `<${name}>: unknown attribute "${k}"`);
		if (v === "") throw new FormatError(line, `<${name}>: attribute "${k}" is empty`);
	}
	for (const r of required) {
		if (!(r in attrs)) throw new FormatError(line, `<${name}>: missing required attribute "${r}"`);
	}
}

function boolAttr(line: number, name: string, attrs: Record<string, string>, key: string, dflt = false): boolean {
	const v = attrs[key];
	if (v === undefined) return dflt;
	if (v !== "true" && v !== "false")
		throw new FormatError(line, `<${name}>: attribute "${key}" must be "true" or "false"`);
	return v === "true";
}

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
function unesc(s: string): string {
	return s.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

/** Tag names belonging to the file grammar. Any other tag-looking line inside
 * a body is content, verbatim; ours at column 0 are structure (and an error
 * when misplaced) — keeps a literal `<comment>`-style hazard loud while
 * passing through real-world HTML like `<details>`. */
const OUR_TAGS = new Set(["gitlab-mr", "gitlab-issue", "description", "discussion_thread", "comment", "code_context"]);

// ─── Serializer ──────────────────────────────────────────────────────

export function serializeDocument(doc: Document): string {
	const out: string[] = [];
	for (const p of doc.preamble) out.push(...serializeHtml(p), "");
	const r = doc.root;
	const tag = r.kind === "mr" ? "gitlab-mr" : "gitlab-issue";
	const rc: Record<string, string> = {
		source: r.source,
		iid: String(r.iid),
		title: r.title,
		state: r.state,
		author: r.author,
		operator_author: String(r.operatorAuthor),
	};
	if (r.draft !== undefined) rc.draft = String(r.draft);
	if (r.headSha !== undefined) rc.head_sha = r.headSha;
	if (r.pipeline !== undefined) rc.pipeline = r.pipeline;
	rc.fetched_at = r.fetchedAt;
	if (r.nonOwner) rc.non_owner = "true";
	out.push(
		`<${tag} ${Object.entries(rc)
			.map(([k, v]) => `${k}="${esc(v)}"`)
			.join(" ")}>`,
	);
	for (const b of doc.blocks) out.push("", ...serializeBlock(b));
	if (doc.blocks.length) out.push("");
	out.push(`</${tag}>`);
	return out.join("\n") + "\n";
}

function serializeHtml(h: HtmlComment): string[] {
	return [...h.raw];
}

function serializeBlock(b: TopBlock): string[] {
	switch (b.type) {
		case "html":
			return serializeHtml(b);
		case "description": {
			const attrs = b.nonOwner ? ` non_owner="true"` : "";
			const lines = [`<description${attrs}>`];
			if (b.body.trim().length) lines.push(...b.body.replace(/\n+$/, "").split("\n"));
			lines.push("</description>");
			return lines;
		}
		case "thread": {
			const t = b;
			const parts = [`id="${esc(t.id)}"`];
			if (t.file !== undefined) parts.push(`file="${esc(t.file)}"`);
			if (t.line !== undefined) parts.push(`line="${t.line}"`);
			if (t.side !== undefined) parts.push(`side="${t.side}"`);
			if (t.resolved !== undefined) parts.push(`resolved="${t.resolved}"`);
			if (t.visible === "unpublished") parts.push(`visible="unpublished"`);
			const out = [`<discussion_thread ${parts.join(" ")}>`];
			for (const c of t.children) out.push("", ...serializeChild(c));
			if (t.children.length) out.push("");
			out.push("</discussion_thread>");
			return out;
		}
	}
}

function serializeChild(c: ThreadChild): string[] {
	switch (c.type) {
		case "html":
			return serializeHtml(c);
		case "code_context": {
			return ["<code_context>", ...c.lines, "</code_context>"];
		}
		case "comment": {
			const parts = [`author="${esc(c.author)}"`, `id="${esc(c.id)}"`];
			if (c.visible === "unpublished") parts.push(`visible="unpublished"`);
			parts.push(`from_operator="${c.fromOperator}"`);
			if (c.viaPi) parts.push(`via_pi="true"`);
			if (c.updateExisting) parts.push(`update_existing_comment="true"`);
			if (c.createdAt) parts.push(`created_at="${esc(c.createdAt)}"`);
			const out = [`<comment ${parts.join(" ")}>`];
			if (c.body.trim().length) out.push(...c.body.replace(/\n+$/, "").split("\n"));
			out.push("</comment>");
			return out;
		}
	}
}

// ─── Parser ──────────────────────────────────────────────────────────

export function parseDocument(text: string): Document {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	// drop trailing empty lines from the split artifact (file ends with \n)
	while (lines.length && lines[lines.length - 1] === "") lines.pop();

	let i = 0;
	const preamble: HtmlComment[] = [];

	// leading html comments / blank lines before root
	while (i < lines.length) {
		const ln = lines[i];
		if (ln.trim() === "") {
			i++;
			continue;
		}
		if (ln.startsWith("<!--")) {
			const { node, next } = parseHtml(lines, i);
			preamble.push(node);
			i = next;
			continue;
		}
		break;
	}
	if (i >= lines.length) throw new FormatError(1, "empty file — expected <gitlab-mr> or <gitlab-issue>");

	const rootTag = parseTagLine(lines[i]);
	if (!rootTag || rootTag.closing || (rootTag.name !== "gitlab-mr" && rootTag.name !== "gitlab-issue")) {
		throw new FormatError(i + 1, "expected root element <gitlab-mr …> or <gitlab-issue …>");
	}
	const rootLine = i + 1;
	const kind: "mr" | "issue" = rootTag.name === "gitlab-mr" ? "mr" : "issue";
	requireAttrs(rootLine, rootTag.name, rootTag.attrs, [
		"source", "iid", "title", "state", "draft", "pipeline", "head_sha", "author",
		"operator_author", "fetched_at", "non_owner",
	], ["source", "iid", "title", "state", "author", "operator_author", "fetched_at"]);
	const iid = Number(rootTag.attrs.iid);
	if (!Number.isInteger(iid) || iid <= 0) throw new FormatError(rootLine, `${rootTag.name}: iid must be a positive integer`);
	const root: RootAttrs = {
		kind,
		source: unesc(rootTag.attrs.source),
		iid,
		title: unesc(rootTag.attrs.title),
		state: rootTag.attrs.state,
		author: unesc(rootTag.attrs.author),
		operatorAuthor: boolAttr(rootLine, rootTag.name, rootTag.attrs, "operator_author"),
		fetchedAt: rootTag.attrs.fetched_at,
	};
	if (rootTag.attrs.draft !== undefined) root.draft = boolAttr(rootLine, rootTag.name, rootTag.attrs, "draft");
	if (rootTag.attrs.pipeline !== undefined) root.pipeline = rootTag.attrs.pipeline;
	if (rootTag.attrs.head_sha !== undefined) root.headSha = rootTag.attrs.head_sha;
	if (rootTag.attrs.non_owner !== undefined) root.nonOwner = boolAttr(rootLine, rootTag.name, rootTag.attrs, "non_owner");
	const closeName = rootTag.name;
	i++;

	const blocks: TopBlock[] = [];
	let sawDescription = false;
	while (i < lines.length) {
		const ln = lines[i];
		if (ln.trim() === "") {
			i++;
			continue;
		}
		if (ln.startsWith("<!--")) {
			const { node, next } = parseHtml(lines, i);
			blocks.push(node);
			i = next;
			continue;
		}
		const tag = parseTagLine(ln);
		if (tag?.closing && tag.name === closeName) {
			i++;
			// only trailing blank lines allowed after root close
			while (i < lines.length && lines[i].trim() === "") i++;
			if (i < lines.length) throw new FormatError(i + 1, "content after root close");
			return { preamble, root, blocks };
		}
		if (tag && !tag.closing && tag.name === "description") {
			if (sawDescription) throw new FormatError(i + 1, "only one <description> block allowed");
			sawDescription = true;
			requireAttrs(i + 1, "description", tag.attrs, ["non_owner"], []);
			const bodyStart = i + 1;
			const bodyLines: string[] = [];
			i++;
			while (i < lines.length && !/^<\/description>$/.test(lines[i])) {
				const t = lines[i].startsWith("<") ? parseTagLine(lines[i]) : null;
				if (t && OUR_TAGS.has(t.name))
					throw new FormatError(i + 1, `unclosed <description> — grammar tag <${t.name}> inside description body (for a literal reserved tag at line start, write &lt;${t.name}&gt;)`);
				bodyLines.push(lines[i]);
				i++;
			}
			if (i >= lines.length) throw new FormatError(bodyStart, "unclosed <description> (missing </description>)");
			i++;
			blocks.push({
				type: "description",
				nonOwner: boolAttr(bodyStart, "description", tag.attrs, "non_owner"),
				body: trimTrailingBlank(bodyLines).join("\n"),
			});
			continue;
		}
		if (tag && !tag.closing && tag.name === "discussion_thread") {
			const { thread, next } = parseThread(lines, i, tag);
			blocks.push(thread);
			i = next;
			continue;
		}
		if (ln.startsWith("<")) {
			const t2 = parseTagLine(ln);
			const name = t2 ? t2.name : ln.slice(0, 20);
			throw new FormatError(i + 1, `unexpected element <${name}> at top level (expected <description>, <discussion_thread>, or </${closeName}>)`);
		}
		throw new FormatError(i + 1, "unexpected content outside any element (did you mean to put it inside <description>?)");
	}
	throw new FormatError(rootLine, `unclosed <${closeName}> (missing </${closeName}>)`);
}

function parseHtml(lines: string[], start: number): { node: HtmlComment; next: number } {
	const raw: string[] = [];
	for (let i = start; i < lines.length; i++) {
		raw.push(lines[i]);
		if (lines[i].includes("-->")) return { node: { type: "html", raw }, next: i + 1 };
	}
	throw new FormatError(start + 1, "unclosed HTML comment (missing -->)");
}

function parseThread(
	lines: string[],
	start: number,
	tag: { name: string; attrs: Record<string, string> },
): { thread: ThreadEl; next: number } {
	const line = start + 1;
	const a = tag.attrs;
	requireAttrs(line, "discussion_thread", a, ["id", "file", "line", "side", "resolved", "visible"], ["id"]);
	const thread: ThreadEl = {
		type: "thread",
		id: unesc(a.id),
		visible: "published",
		children: [],
	};
	if (a.visible !== undefined) {
		if (a.visible !== "published" && a.visible !== "unpublished")
			throw new FormatError(line, `<discussion_thread>: visible must be "published" or "unpublished"`);
		thread.visible = a.visible;
	}
	if (a.resolved !== undefined) thread.resolved = boolAttr(line, "discussion_thread", a, "resolved");
	if (a.file !== undefined) thread.file = unesc(a.file);
	if (a.line !== undefined) {
		const n = Number(a.line);
		if (!Number.isInteger(n) || n <= 0) throw new FormatError(line, "<discussion_thread>: line must be a positive integer");
		thread.line = n;
	}
	if (a.side !== undefined) {
		if (a.side !== "new" && a.side !== "old") throw new FormatError(line, `<discussion_thread>: side must be "new" or "old"`);
		thread.side = a.side;
	}
	if (thread.line !== undefined && thread.file === undefined)
		throw new FormatError(line, "<discussion_thread>: line given without file");

	let i = start + 1;
	while (i < lines.length) {
		const ln = lines[i];
		if (ln.startsWith("<!--")) {
			const { node, next } = parseHtml(lines, i);
			thread.children.push(node);
			i = next;
			continue;
		}
		const tag2 = ln.startsWith("<") ? parseTagLine(ln) : null;
		if (tag2?.closing && tag2.name === "discussion_thread") {
			return { thread, next: i + 1 };
		}
		if (tag2 && !tag2.closing && tag2.name === "code_context") {
			const ctx: CodeContextEl = { type: "code_context", lines: [] };
			thread.children.push(ctx);
			i++;
			const startLine = i;
			while (i < lines.length && lines[i] !== "</code_context>") {
				const t = lines[i].startsWith("<") ? parseTagLine(lines[i]) : null;
				if (t && OUR_TAGS.has(t.name))
					throw new FormatError(i + 1, `grammar tag <${t.name}> inside <code_context> body`);
				ctx.lines.push(lines[i]);
				i++;
			}
			if (i >= lines.length) throw new FormatError(startLine, "unclosed <code_context>");
			trimTrailingBlankInPlace(ctx.lines);
			i++;
			continue;
		}
		if (tag2 && !tag2.closing && tag2.name === "comment") {
			const el: CommentEl = {
				type: "comment",
				author: unesc(tag2.attrs.author ?? ""),
				id: unesc(tag2.attrs.id ?? ""),
				visible: "published",
				fromOperator: false,
				viaPi: false,
				updateExisting: false,
				body: "",
			};
			requireAttrs(i + 1, "comment", tag2.attrs, [
				"author", "id", "visible", "from_operator", "via_pi", "update_existing_comment", "created_at",
			], ["author", "id"]);
			if (tag2.attrs.visible !== undefined) {
				if (tag2.attrs.visible !== "published" && tag2.attrs.visible !== "unpublished")
					throw new FormatError(i + 1, `<comment>: visible must be "published" or "unpublished"`);
				el.visible = tag2.attrs.visible;
			}
			el.fromOperator = boolAttr(i + 1, "comment", tag2.attrs, "from_operator");
			el.viaPi = boolAttr(i + 1, "comment", tag2.attrs, "via_pi");
			el.updateExisting = boolAttr(i + 1, "comment", tag2.attrs, "update_existing_comment");
			if (tag2.attrs.created_at !== undefined) el.createdAt = unesc(tag2.attrs.created_at);
			const bodyLines: string[] = [];
			const commentLine = i + 1;
			i++;
			while (i < lines.length && lines[i] !== "</comment>") {
				const t = lines[i].startsWith("<") ? parseTagLine(lines[i]) : null;
				if (t && OUR_TAGS.has(t.name))
					throw new FormatError(i + 1, `grammar tag <${t.name}> inside <comment> body (for a literal reserved tag at line start, write &lt;${t.name}&gt;)`);
				bodyLines.push(lines[i]);
				i++;
			}
			if (i >= lines.length) throw new FormatError(commentLine, "unclosed <comment>");
			el.body = trimTrailingBlank(bodyLines).join("\n");
			thread.children.push(el);
			i++;
			continue;
		}
		if (tag2) {
			throw new FormatError(i + 1, `unexpected <${tag2.name}> inside <discussion_thread>`);
		}
		if (ln.trim() === "") {
			i++;
			continue;
		}
		throw new FormatError(i + 1, "content inside <discussion_thread> outside any child element");
	}
	throw new FormatError(start + 1, "unclosed <discussion_thread> (missing </discussion_thread>)");
}

function trimTrailingBlank(lines: string[]): string[] {
	const copy = [...lines];
	while (copy.length && copy[copy.length - 1] === "") copy.pop();
	return copy;
}
function trimTrailingBlankInPlace(lines: string[]): void {
	while (lines.length && lines[lines.length - 1] === "") lines.pop();
}

// ─── Conflict markers (git merge-file, plan §5.1/§7 guard) ───────────

export function findConflictMarkers(text: string): { line: number; marker: string }[] {
	const out: { line: number; marker: string }[] = [];
	text.split("\n").forEach((ln, idx) => {
		// `=======` must be exactly 7+ equals and nothing else on the line
		if (/^<{7}(\s|$)/.test(ln) || /^>{7}(\s|$)/.test(ln) || /^\|{7}(\s|$)/.test(ln) || /^={7,}\s*$/.test(ln)) {
			out.push({ line: idx + 1, marker: ln.slice(0, 7) });
		}
	});
	return out;
}

// ─── Convenience queries ─────────────────────────────────────────────

export function findThread(doc: Document, id: string): ThreadEl | undefined {
	return doc.blocks.find((b): b is ThreadEl => b.type === "thread" && b.id === id);
}

export function findDescription(doc: Document): DescriptionEl | undefined {
	return doc.blocks.find((b): b is DescriptionEl => b.type === "description");
}

export function threadComments(thread: ThreadEl): CommentEl[] {
	return thread.children.filter((c): c is CommentEl => c.type === "comment");
}

export function isDraftComment(c: CommentEl): boolean {
	return c.visible === "unpublished";
}
export function isDraftThread(t: ThreadEl): boolean {
	return t.visible === "unpublished" || t.id === "unset";
}
