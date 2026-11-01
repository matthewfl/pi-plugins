#!/usr/bin/env node
/**
 * Two-phase rehearsal of the watch tick against a live instance:
 *   node scripts/live-watch-check.ts <url> baseline   # snapshot "seen" state
 *   node scripts/live-watch-check.ts <url> check      # diff vs baseline, print notice
 * Between the two, change something on GitLab (e.g. post a comment).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parseGitLabUrl, labelFor } from "../url.ts";
import { effectiveBypassPatterns, loadAuth, loadConfig } from "../auth.ts";
import { GitLabClient } from "../client.ts";
import { buildSnapshot, readState } from "../fetch.ts";
import { dataRoot } from "../paths.ts";
import { captureSeen, classifyChanges, formatWatchNotice } from "../watch.ts";

const [url, phase, seenFile = "/tmp/pi-gitlab-watch-seen.json"] = process.argv.slice(2);
if (!url || (phase !== "baseline" && phase !== "check")) {
	console.error("usage: node scripts/live-watch-check.ts <url> baseline|check [seen-file]");
	process.exit(1);
}
const parsed = parseGitLabUrl(url);
if (!parsed.ok) throw new Error(parsed.error);
const ref = parsed.ref;
const auth = await loadAuth(ref.baseUrl);
if (!auth) throw new Error(`no token for ${ref.baseUrl}`);
const cfg = await loadConfig();
const client = new GitLabClient(ref.baseUrl, auth.token, {});
const username = auth.username ?? (await client.getCurrentUser()).username;
const snapshot = await buildSnapshot(ref, client);

if (phase === "baseline") {
	const seen = captureSeen(snapshot);
	writeFileSync(
		seenFile,
		JSON.stringify({ noteKeys: [...seen.noteKeys], resolvedByDisc: [...seen.resolvedByDisc], headSha: seen.headSha, pipeline: seen.pipeline, state: seen.state }),
	);
	console.log(`baseline captured: ${seen.noteKeys.size} notes, state=${seen.state}, head=${seen.headSha?.slice(0, 7) ?? "-"} → ${seenFile}`);
} else {
	if (!existsSync(seenFile)) throw new Error(`no baseline at ${seenFile} — run phase 'baseline' first`);
	const raw = JSON.parse(readFileSync(seenFile, "utf8"));
	const seen = {
		noteKeys: new Set<string>(raw.noteKeys),
		resolvedByDisc: new Map<string, boolean>(raw.resolvedByDisc),
		headSha: raw.headSha,
		pipeline: raw.pipeline,
		state: raw.state,
	};
	const st = await readState(ref, dataRoot());
	const { notice } = classifyChanges(seen, snapshot, username, cfg.signatureHeader, {
		viaPiNoteIds: new Set(st?.viaPiNoteIds ?? []),
		bypass: effectiveBypassPatterns(cfg, ref.baseUrl),
	});
	if (!notice) console.log("(no notification-worthy changes)");
	else console.log(formatWatchNotice(labelFor(ref, snapshot.title), notice, "(file would be updated by the tick)", false));
}
