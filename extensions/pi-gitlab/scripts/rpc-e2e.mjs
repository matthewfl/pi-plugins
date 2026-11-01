#!/usr/bin/env node
/**
 * Fresh-session end-to-end: the MODEL calls gitlab_fetch natively in a new
 * pi (rpc mode, project auto-discovery). Proves staged gating (session_start
 * restrict) + registration + the real tool execute path in one go.
 * Prints the observed event timeline; exits 0 iff gitlab_fetch ran OK.
 */
import { spawn } from "node:child_process";

const MR = process.env.PI_GITLAB_TEST_MR_URL ??
	"https://gitlab.example.com/group/project/-/merge_requests/1"; // set PI_GITLAB_TEST_MR_URL to a real test MR
const REPO = "/home/matthew/developer/agents";

const child = spawn(
	"pi",
	["--mode", "rpc", "--no-session"],
	{ cwd: REPO, env: { ...process.env } },
);

const PROMPT = `Use the gitlab_fetch tool exactly once on this URL: ${MR} — then reply with the file path it reports. Do nothing else.`;
setTimeout(() => {
	child.stdin.write(JSON.stringify({ id: "req-1", type: "prompt", message: PROMPT }) + "\n");
}, 5000);

let sawFetch = false, fetchOk = false, loadError = null, finalText = "";
const seenTypes = new Set();
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
		seenTypes.add(ev.type);
		if (ev.type === "tool_execution_start" && /gitlab_fetch/.test(JSON.stringify(ev))) sawFetch = true;
		if (ev.type === "tool_execution_end" && /gitlab_fetch/.test(JSON.stringify(ev))) {
			fetchOk = !ev.isError;
			if (ev.isError) console.error("gitlab_fetch errored:", JSON.stringify(ev).slice(0, 400));
		}
		if (ev.type === "message_end" && ev.message?.role === "assistant") {
			const t = (ev.message.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
			if (t) finalText = t;
		}
	}
});
child.stderr.on("data", (d) => {
	const s = String(d);
	if (/Failed to load extension/.test(s)) loadError = s.trim();
});

const deadline = Date.now() + 240000;
while (Date.now() < deadline && !(fetchOk || loadError)) {
	await new Promise((r) => setTimeout(r, 1000));
}
child.stdin.end();
child.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 500));

console.log("event types seen:", [...seenTypes].sort().join(", "));
console.log("assistant said:", finalText.slice(0, 300));

if (loadError) { console.error(`❌ extension load error: ${loadError}`); process.exit(1); }
if (!sawFetch) { console.error("❌ model never called gitlab_fetch (tool not visible?)"); process.exit(1); }
if (!fetchOk) { console.error("❌ gitlab_fetch returned an error"); process.exit(1); }
console.log("✅ fresh-session model-facing e2e passed: model called gitlab_fetch successfully");
process.exit(0);
