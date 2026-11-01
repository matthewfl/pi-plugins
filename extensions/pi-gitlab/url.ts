/**
 * GitLab MR/issue URL parsing (plan §6 step 1, §11 known limitation:
 * subpath installs like https://corp.com/gitlab are not supported).
 */

export type ItemKind = "mr" | "issue";

export interface GitLabItemRef {
	/** e.g. "https://gitlab.com" (scheme + host[:port], no trailing slash) */
	baseUrl: string;
	/** host[:port], lowercased — auth.json key portion */
	host: string;
	/** e.g. "my-group/my-project" */
	projectPath: string;
	kind: ItemKind;
	iid: number;
	/** canonical item URL */
	url: string;
}

export type ParseResult = { ok: true; ref: GitLabItemRef } | { ok: false; error: string };

const KIND_SEGMENT: Record<string, ItemKind> = {
	merge_requests: "mr",
	issues: "issue",
};

export function parseGitLabUrl(raw: string): ParseResult {
	const trimmed = raw.trim();
	let u: URL;
	try {
		u = new URL(trimmed);
	} catch {
		return { ok: false, error: `not a valid URL: ${JSON.stringify(trimmed)}` };
	}
	if (u.protocol !== "https:" && u.protocol !== "http:") {
		return { ok: false, error: `unsupported scheme ${u.protocol} (expected http(s))` };
	}
	let path = u.pathname.replace(/\/+$/, "");
	// Split on the first "/-/" boundary: project path comes before it.
	const marker = path.indexOf("/-/");
	if (marker === -1) {
		return {
			ok: false,
			error:
				"unsupported GitLab URL type — expected …/-/merge_requests/<id> or …/-/issues/<id>",
		};
	}
	const projectPath = path.slice(0, marker).replace(/^\/+/, "");
	const rest = path.slice(marker + 3); // after "/-/"
	const segMatch = rest.match(/^([a-z_]+)\/(\d+)(?:[/?#].*)?$/i);
	if (!segMatch || !KIND_SEGMENT[segMatch[1].toLowerCase()]) {
		return {
			ok: false,
			error:
				"unsupported GitLab URL type — expected …/-/merge_requests/<id> or …/-/issues/<id>",
		};
	}
	if (!projectPath || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(projectPath)) {
		return { ok: false, error: `could not parse project path from ${JSON.stringify(path)}` };
	}
	const kind = KIND_SEGMENT[segMatch[1].toLowerCase()];
	const iid = Number(segMatch[2]);
	const host = u.host.toLowerCase();
	const baseUrl = `${u.protocol}//${host}`;
	return {
		ok: true,
		ref: {
			baseUrl,
			host,
			projectPath,
			kind,
			iid,
			url: `${baseUrl}/${projectPath}/-/${kind === "mr" ? "merge_requests" : "issues"}/${iid}`,
		},
	};
}

/** File-name-safe identity of a watched/fetched item (plan §1 naming). */
/**
 * Filesystem-safe, INJECTIVE encoding (found in live review on MR !1: the old
 * s/\//_/ mapping collapsed "group/proj_x" and "group_proj/x" into one slug).
 * Order matters: '%' first, then chars introduced by later steps can't collide
 * with literal ones ('%25' before '%2F' etc.).
 */
function fsEncode(s: string): string {
	return s.replace(/%/g, "%25").replace(/_/g, "%5F").replace(/:/g, "%3A").replace(/\//g, "%2F");
}

export function slugFor(ref: GitLabItemRef): string {
	return `${fsEncode(ref.host)}__${fsEncode(ref.projectPath)}__${ref.kind}-${ref.iid}`;
}

/** Short human label for notifications, e.g. "!42 my-project (my-group/my-project)". */
export function labelFor(ref: GitLabItemRef, title?: string): string {
	const short = ref.projectPath.split("/").pop() ?? ref.projectPath;
	const num = ref.kind === "mr" ? `!${ref.iid}` : `#${ref.iid}`;
	return title ? `${num} ${short} (${title})` : `${num} ${short} (${ref.projectPath})`;
}
