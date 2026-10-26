#!/usr/bin/env node
/**
 * Acceptance-level e2e: a fresh agent session does a realistic review task
 * on MR !1 using the gitlab tools conversationally — fetch, stage an inline
 * code comment + a summary comment in the item file, dry_run, submit
 * (confirm gate auto-approved after capture). Prints the resulting calls.
 */
import { spawn } from "node:child_process";

const MR = process.env.PI_GITLAB_TEST_MR_URL ??
	"https://gitlab.example.com/group/project/-/merge_requests/1"; // set PI_GITLAB_TEST_MR_URL to a real test MR
const REPO = "/home/matthew/developer/agents";
const ITEM = process.env.PI_GITLAB_TEST_ITEM_FILE ?? "the item file path printed by gitlab_fetch";

const PROMPT = [
	`Do a small review of the merge request at ${MR}`,
	"Steps, in order:",
	"1. Call gitlab_fetch with that URL.",
	"2. Read ONLY these two source files (small): extensions/pi-gitlab/activation.ts and extensions/pi-gitlab/url.ts in this repo.",
	`3. Edit the item file (${ITEM}) to stage: (a) one inline review comment anchored on a specific real line of one of those two files (must be a line present in the MR diff — quote the line content in your comment to show you read it) pointing out something genuinely worth improving; (b) one new top-level comment summarizing the review in 2-3 sentences. Both as visible="unpublished" staged elements per the file's own templates.`,
	"4. Call gitlab_put with mode dry_run on that path.",
	"5. Call gitlab_put with mode submit on that path.",
	"Then stop. Do not modify any source files.",
].join("\n");

const child = spawn("pi", ["--mode", "rpc", "--no-session"], { cwd: REPO, env: { ...process.env } });
const waiters = [];
const fire = (ev) => { for (const w of waiters.slice()) if (w.pred(ev)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ev); } };
function waitFor(pred, ms, label) {
	return new Promise((resolve, reject) => {
		const w = { pred, resolve };
		waiters.push(w);
		setTimeout(() => { const i = waiters.indexOf(w); if (i !== -1) { waiters.splice(i, 1); reject(new Error("timeout: " + label)); } }, ms);
	});
}
const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
const state = { calls: [], confirmPreview: null, putSubmitted: false, review: "" };

let buf = "";
child.stdout.on("data", (d) => {
	buf += d;
	let i;
	while ((i = buf.indexOf("\n")) !== -1) {
		const line = buf.slice(0, i).trim();
		buf = buf.slice(i + 1);
		if (!line) continue;
		let ev;
		try { ev = JSON.parse(line); } catch { continue; }
		if (ev.type === "tool_execution_start") {
			const s = JSON.stringify(ev);
			const m = s.match(/"toolName":"([^"]+)"/);
			if (m && /gitlab|edit|write|read|find|grep/.test(m[1])) state.calls.push(m[1]);
		}
		if (ev.type === "extension_ui_request" && ev.method === "confirm") {
			state.confirmPreview = `${ev.title}\n${ev.message ?? ""}`;
			send({ type: "extension_ui_response", id: ev.id, confirmed: true });
			console.log("✓ confirm gate auto-approved");
		}
		if (ev.type === "tool_execution_end" && ev.toolName === "gitlab_put" && !ev.isError) {
			const s = JSON.stringify(ev.result ?? ev.content ?? "");
			// index.ts submit result text: "N posted, M failed.…"; dry_run says "planned actions"
			if (/\d+ posted,/.test(s)) state.putSubmitted = true;
		}
		if (ev.type === "message_end" && ev.message?.role === "assistant") {
			const t = (ev.message.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
			if (t.trim()) state.review = t;
		}
		fire(ev);
	}
});

const deadline = Date.now() + 9 * 60 * 1000;
let done = null;
(async () => {
	await new Promise((r) => setTimeout(r, 5000));
	send({ id: "p1", type: "prompt", message: PROMPT });
	const t0 = Date.now();
	while (Date.now() - t0 < 8 * 60 * 1000) {
		await new Promise((r) => setTimeout(r, 3000));
		if (state.putSubmitted) { await new Promise((r) => setTimeout(r, 8000)); break; }
	}
	done = true;
})().catch((e) => { console.error(e); done = true; });

while (!done && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
child.kill("SIGTERM");

const gcalls = state.calls.filter((c) => c.startsWith("gitlab"));
console.log("--- gitlab tool calls:", gcalls.join(" → ") || "(none)");
console.log("--- all tool calls:", state.calls.join(", "));
if (state.confirmPreview) console.log("--- gate preview (first 8 lines):\n" + state.confirmPreview.split("\n").slice(0, 8).join("\n"));
console.log("--- assistant final text (first 400):\n" + state.review.slice(0, 400));
if (!state.putSubmitted) { console.error("❌ no successful gitlab_put submit observed"); process.exit(1); }
console.log("✅ review-task acceptance e2e passed");
process.exit(0);
