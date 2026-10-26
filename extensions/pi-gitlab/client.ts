/**
 * Zero-dependency GitLab REST v4 client on global fetch (plan §1, §11).
 * Tokens go in the PRIVATE-TOKEN header only — never into errors or output.
 */

import type { ItemKind } from "./url.ts";

export class GitLabError extends Error {
	status: number;
	hint?: string;
	constructor(status: number, message: string, hint?: string) {
		super(message);
		this.name = "GitLabError";
		this.status = status;
		this.hint = hint;
	}
}

export interface DiffRefs {
	base_sha: string;
	start_sha: string;
	head_sha: string;
}

export interface MergeRequest {
	iid: number;
	title: string;
	description: string | null;
	state: string; // opened | merged | closed | locked
	draft: boolean;
	author: { username: string };
	sha: string;
	updated_at: string;
	web_url: string;
	diff_refs: DiffRefs;
	head_pipeline?: { status: string } | null;
}

export interface Issue {
	iid: number;
	title: string;
	description: string | null;
	state: string; // opened | closed
	author: { username: string };
	updated_at: string;
	web_url: string;
}

export interface NotePosition {
	position_type: string;
	base_sha: string;
	start_sha: string;
	head_sha: string;
	old_path: string;
	new_path: string;
	old_line: number | null;
	new_line: number | null;
}

export interface Note {
	id: number;
	author: { username: string };
	body: string;
	created_at: string;
	system: boolean;
	resolvable: boolean;
	resolved: boolean;
	type?: string | null;
	position?: NotePosition | null;
}

export interface Discussion {
	id: string;
	individual_note: boolean;
	notes: Note[];
}

export interface CurrentUser {
	id: number;
	username: string;
	name: string;
}

export interface ClientOptions {
	fetchImpl?: typeof fetch;
	/** injectable for tests; resolves after ms */
	sleep?: (ms: number) => Promise<void>;
	/** max pagination pages (100/page) */
	maxPages?: number;
}

const API = "/api/v4";
const PER_PAGE = 100;
const PP_FLOOR = 10;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class GitLabClient {
	baseUrl: string;
	private token: string;
	private fetchImpl: typeof fetch;
	private sleep: (ms: number) => Promise<void>;
	private maxPages: number;

	constructor(baseUrl: string, token: string, opts: ClientOptions = {}) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.token = token;
		this.fetchImpl = opts.fetchImpl ?? fetch;
		this.sleep = opts.sleep ?? defaultSleep;
		this.maxPages = opts.maxPages ?? 20;
	}

	private async request<T>(
		method: string,
		path: string,
		body?: unknown,
		isRetry = false,
	): Promise<T> {
		const url = `${this.baseUrl}${API}${path}`;
		let res: Response;
		try {
			res = await this.fetchImpl(url, {
				method,
				headers: {
					"PRIVATE-TOKEN": this.token,
					...(body !== undefined ? { "Content-Type": "application/json" } : {}),
				},
				body: body !== undefined ? JSON.stringify(body) : undefined,
			});
		} catch (e) {
			throw new GitLabError(
				0,
				`cannot reach ${this.baseUrl}: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
		if ((res.status === 429 || res.status >= 500) && !isRetry) {
			const ra = Number(res.headers.get("retry-after") ?? "");
			const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 5) * 1000 : 1000;
			await this.sleep(wait);
			return this.request<T>(method, path, body, true);
		}
		if (!res.ok) {
			let detail = "";
			try {
				const j = (await res.json()) as { message?: unknown; error?: unknown };
				const m = j.message ?? j.error;
				detail = typeof m === "string" ? m : m ? JSON.stringify(m) : "";
			} catch {
				/* non-json body */
			}
			detail = detail.slice(0, 300);
			const hint =
				res.status === 401
					? "token rejected — re-run /gitlab-auth"
					: res.status === 403
						? 'insufficient scope — the token needs the "api" scope (or the operation is not permitted for this user)'
						: res.status === 404
							? "not found — check project visibility and that the token belongs to this host"
							: undefined;
			throw new GitLabError(res.status, `GitLab ${res.status}: ${detail || res.statusText}`, hint);
		}
		if (res.status === 204) return undefined as T;
		return (await res.json()) as T;
	}

	private project(p: string): string {
		return encodeURIComponent(p);
	}
	private kindPath(kind: ItemKind): string {
		return kind === "mr" ? "merge_requests" : "issues";
	}

	getCurrentUser(): Promise<CurrentUser> {
		return this.request<CurrentUser>("GET", "/user");
	}

	/**
	 * Paginate a list endpoint with adaptive per_page. Observed in the wild:
	 * a GitLab 15.11-ee instance behind an ingress that kills large API
	 * responses (500 once the page exceeds ~150KB) — smaller pages succeed.
	 * On 429/5xx with per_page still above the floor, halve it and restart
	 * from page 1 instead of failing the whole listing.
	 */
	private async paginate<T>(path: string): Promise<T[]> {
		let pp = PER_PAGE;
		for (;;) {
			try {
				const out: T[] = [];
				for (let page = 1; page <= this.maxPages; page++) {
					const batch = await this.request<T[]>("GET", `${path}?per_page=${pp}&page=${page}`);
					out.push(...batch);
					if (batch.length < pp) return out;
				}
				return out;
			} catch (e) {
				if (pp > PP_FLOOR && e instanceof GitLabError && (e.status === 429 || e.status >= 500)) {
					pp = Math.max(PP_FLOOR, Math.floor(pp / 2));
					continue;
				}
				throw e;
			}
		}
	}

	getMergeRequest(project: string, iid: number): Promise<MergeRequest> {
		return this.request<MergeRequest>(
			"GET",
			`/projects/${this.project(project)}/merge_requests/${iid}`,
		);
	}

	getIssue(project: string, iid: number): Promise<Issue> {
		return this.request<Issue>("GET", `/projects/${this.project(project)}/issues/${iid}`);
	}

	/** All discussions across pages, oldest first (GitLab default order). */
	async listDiscussions(
		project: string,
		kind: ItemKind,
		iid: number,
	): Promise<Discussion[]> {
		return this.paginate<Discussion>(
			`/projects/${this.project(project)}/${this.kindPath(kind)}/${iid}/discussions`,
		);
	}

	/** Raw per-file diffs of an MR (drives <code_context> + put anchor validation). */
	async getMrDiffs(
		project: string,
		iid: number,
	): Promise<{ old_path: string; new_path: string; diff: string }[]> {
		return this.paginate<{ old_path: string; new_path: string; diff: string }>(
			`/projects/${this.project(project)}/merge_requests/${iid}/diffs`,
		);
	}

	createDiscussion(
		project: string,
		kind: ItemKind,
		iid: number,
		body: string,
		position?: Partial<NotePosition>,
	): Promise<Discussion> {
		return this.request<Discussion>(
			"POST",
			`/projects/${this.project(project)}/${this.kindPath(kind)}/${iid}/discussions`,
			position ? { body, position } : { body },
		);
	}

	addNote(
		project: string,
		kind: ItemKind,
		iid: number,
		discussionId: string,
		body: string,
	): Promise<Note> {
		return this.request<Note>(
			"POST",
			`/projects/${this.project(project)}/${this.kindPath(kind)}/${iid}/discussions/${encodeURIComponent(discussionId)}/notes`,
			{ body },
		);
	}

	updateNote(
		project: string,
		kind: ItemKind,
		iid: number,
		discussionId: string,
		noteId: number,
		body: string,
	): Promise<Note> {
		return this.request<Note>(
			"PUT",
			`/projects/${this.project(project)}/${this.kindPath(kind)}/${iid}/discussions/${encodeURIComponent(discussionId)}/notes/${noteId}`,
			{ body },
		);
	}

	/** MR only — issues have no resolvable threads. */
	resolveDiscussion(
		project: string,
		iid: number,
		discussionId: string,
		resolved: boolean,
	): Promise<Discussion> {
		return this.request<Discussion>(
			"PUT",
			`/projects/${this.project(project)}/merge_requests/${iid}/discussions/${encodeURIComponent(discussionId)}`,
			{ resolved },
		);
	}

	updateDescription(project: string, kind: ItemKind, iid: number, description: string): Promise<unknown> {
		return this.request(
			"PUT",
			`/projects/${this.project(project)}/${this.kindPath(kind)}/${iid}`,
			{ description },
		);
	}

	updateTitle(project: string, kind: ItemKind, iid: number, title: string): Promise<unknown> {
		return this.request(
			"PUT",
			`/projects/${this.project(project)}/${this.kindPath(kind)}/${iid}`,
			{ title },
		);
	}
}
