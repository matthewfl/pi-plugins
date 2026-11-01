#!/usr/bin/env node
/**
 * Live smoke test of the fetch path against a real GitLab instance:
 *   node scripts/live-fetch.ts <mr-or-issue-url>
 * Uses the real data dir (~/.pi/agent/gitlab/, override with PI_GITLAB_DIR)
 * and real auth.json. Prints a summary; inspect the .gitlab.md file it writes.
 */
import { readFileSync } from "node:fs";
import { parseGitLabUrl, labelFor } from "../url.ts";
import { loadAuth, loadConfig } from "../auth.ts";
import { GitLabClient } from "../client.ts";
import { buildSnapshot, applySnapshot } from "../fetch.ts";
import { statePath, dataRoot } from "../paths.ts";

const url = process.argv[2];
if (!url) {
	console.error("usage: node scripts/live-fetch.ts <gitlab-mr-or-issue-url>");
	process.exit(1);
}

const parsed = parseGitLabUrl(url);
if (!parsed.ok) {
	console.error(`parse error: ${parsed.error}`);
	process.exit(1);
}
const ref = parsed.ref;
console.log(`[1/4] parsed: ${labelFor(ref, "…")} @ ${ref.baseUrl}`);

const auth = await loadAuth(ref.baseUrl);
if (!auth) {
	console.error(`no token for ${ref.baseUrl} — run: node scripts/auth-setup.ts ${ref.baseUrl}`);
	process.exit(1);
}
const cfg = await loadConfig();
const client = new GitLabClient(ref.baseUrl, auth.token, {});

console.log("[2/4] fetching snapshot…");
const t0 = Date.now();
const snapshot = await buildSnapshot(ref, client);
const ms = Date.now() - t0;
const notes = snapshot.discussions.reduce((n, d) => n + d.notes.length, 0);
console.log(
	`      ok in ${ms}ms — "${snapshot.title}" — ${snapshot.discussions.length} discussions, ${notes} notes` +
		(snapshot.headSha ? `, head ${snapshot.headSha.slice(0, 7)}` : "") +
		`, updated ${snapshot.serverUpdatedAt}`,
);

console.log("[3/4] applying snapshot (render + merge + sidecars)…");
const root = dataRoot();
const res = await applySnapshot(snapshot, { operatorUsername: auth.username ?? "", signatureHeader: cfg.signatureHeader }, root);
const sPath = statePath(ref, root);
console.log(`      file:   ${res.filePath}`);
console.log(`      diff:   ${res.filePath}.diff`);
console.log(`      state:  ${sPath}`);
console.log(`      conflicted: ${res.conflicted}, serverChanged: ${res.serverChanged}`);

const state = JSON.parse(readFileSync(sPath, "utf8"));
console.log(`[4/4] state.json: fetchedAt=${state.fetchedAt} serverUpdatedAt=${state.serverUpdatedAt}`);
console.log("\n✅ live fetch complete — review the item file, then edit + test put via scripts/live-put.ts");
