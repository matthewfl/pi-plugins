#!/usr/bin/env node
/**
 * Live driver for the gitlab_put pipeline (minus the TUI confirm gate):
 *   node scripts/live-put.ts <item-file.gitlab.md> [--submit]
 * Default is a dry run: validates actions against fresh server state and
 * prints the preview. With --submit it executes and re-renders the file.
 */
import { readFileSync } from "node:fs";
import { parseGitLabUrl } from "../url.ts";
import { effectiveBypassPatterns, loadAuth, loadConfig } from "../auth.ts";
import { GitLabClient } from "../client.ts";
import { buildSnapshot, applySnapshot } from "../fetch.ts";
import {
	computeActions,
	executeActions,
	describeAction,
	staleBaselineIssue,
	annotateFailuresInFile,
	reconcileAfterSubmit,
} from "../put.ts";
import { parseDocument } from "../format.ts";
import { dataRoot } from "../paths.ts";

const filePath = process.argv[2];
const submit = process.argv.includes("--submit");
if (!filePath) {
	console.error("usage: node scripts/live-put.ts <item-file.gitlab.md> [--submit]");
	process.exit(1);
}

const raw = readFileSync(filePath, "utf8");
const doc = parseDocument(raw);
const parsed = parseGitLabUrl(doc.root.source);
if (!parsed.ok) throw new Error(parsed.error);
const ref = parsed.ref;

const [cfg, auth] = await Promise.all([loadConfig(), loadAuth(ref.baseUrl)]);
if (!auth) throw new Error(`no token for ${ref.baseUrl}`);
const client = new GitLabClient(ref.baseUrl, auth.token, {});
const username = auth.username ?? (await client.getCurrentUser()).username;

console.log("[1/4] refreshing server state…");
const server = await buildSnapshot(ref, client);

console.log("[2/4] computing actions…");
const bypass = effectiveBypassPatterns(cfg, ref.baseUrl);
const { actions, errors, warnings } = computeActions(doc, server, username, raw, bypass);
const stale = staleBaselineIssue(doc, server, submit ? "submit" : "dry_run");
if (stale) (stale.level === "error" ? errors : warnings).push(stale);
for (const w of warnings) console.log(`  warning: ${w.message}`);
for (const e of errors) console.log(`  ERROR: ${e.message}`);
if (errors.length) process.exit(1);
if (!actions.length) {
	console.log("  nothing to do — no staged changes");
	process.exit(0);
}
console.log(`[3/4] ${actions.length} action(s):`);
actions.forEach((a, i) => console.log(`  ${describeAction(a, i)}`));

if (!submit) {
	console.log("\ndry run only — rerun with --submit to execute");
	process.exit(0);
}

console.log("[4/4] executing…");
const outcomes = await executeActions(client, ref, actions, {
	signatureHeader: cfg.signatureHeader,
	operatorUsername: username,
	diffRefs: server.diffRefs,
});
let failed = 0;
outcomes.forEach((o, i) => {
	if (o.ok) console.log(`  ✓ ${describeAction(o.action, i)}`);
	else {
		failed++;
		console.log(`  ✗ ${describeAction(o.action, i)} — ${o.error}`);
	}
});

await reconcileAfterSubmit(filePath, outcomes);
console.log("re-rendering file from post-submit snapshot…");
const postedIds = outcomes.map((o) => o.postedNoteId).filter((n): n is number => n !== undefined);
const res = await applySnapshot(
	await buildSnapshot(ref, client),
	{ operatorUsername: username, signatureHeader: cfg.signatureHeader },
	dataRoot(),
	undefined,
	postedIds,
);
await annotateFailuresInFile(
	res.filePath,
	outcomes.filter((o) => !o.ok).map((o) => ({ body: o.action.type === "resolve" ? "" : (o.action as { body?: string }).body ?? "", error: o.error ?? "failed" })),
);
console.log(`\n${failed ? "⚠" : "✅"} done: ${outcomes.length - failed}/${outcomes.length} ok; file: ${res.filePath}`);
process.exit(failed ? 2 : 0);
