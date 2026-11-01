#!/usr/bin/env node
/**
 * Watch attribution acceptance: a change that is silent BY POLICY (a
 * whitelisted trigger body, e.g. the operator posting "ci test" by hand)
 * must (a) not notify, and (b) appear attributed in gitlab_watch list —
 * so "why didn't the watch notify on my post?" is answered on demand
 * instead of by archaeology. Then a normal comment must still notify.
 *
 * No live-instance defaults: set PI_GITLAB_TEST_MR_URL (host, project, iid
 * all derive from it). The instance's config.json must have a whitelist
 * pattern matching "ci test" for the operator's account.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const MR = process.env.PI_GITLAB_TEST_MR_URL ?? "https://gitlab.example.com/group/project/-/merge_requests/1";
const BASE = new URL(MR).origin;
const PROJ = new URL(MR).pathname.split("/-/")[0].slice(1).split("/").map(encodeURIComponent).join("%2F");
const IID = new URL(MR).pathname.split("/-/")[1].split("/")[1];
const REPO = "/home/matthew/developer/agents";

const child = spawn("pi", ["--mode", "rpc", "--no-session"], { cwd: REPO, env: { ...process.env } });
const state = { notices: [], toolEnds: [], turnDone: false, loadError: null };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
		if (ev.type === "extension_ui_request" && ev.method === "confirm")
			child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: ev.id, confirmed: true }) + "\n");
		if (ev.type === "tool_execution_end") state.toolEnds.push({ name: ev.toolName, isError: !!ev.isError, text: JSON.stringify(ev).slice(0, 900) });
		if (/"user"|message_end/.test(ev.type) && /\[gitlab watch\]/.test(JSON.stringify(ev))) state.notices.push(JSON.stringify(ev).slice(0, 400));
		if (ev.type === "agent_end") state.turnDone = true;
	}
});
child.stderr.on("data", (d) => { if (/Failed to load extension/.test(String(d))) state.loadError = String(d); });

async function turn(message, timeoutMs = 240000) {
	state.toolEnds = []; state.turnDone = false;
	child.stdin.write(JSON.stringify({ type: "prompt", message }) + "\n");
	const t0 = Date.now();
	while (!state.turnDone) {
		if (Date.now() - t0 > timeoutMs) throw new Error(`turn never finished (tools: ${state.toolEnds.map((t) => t.name).join(",") || "none"})`);
		await sleep(1000);
	}
}
async function apiPost(path, body) {
	const token = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/gitlab/config/auth.json`, "utf8"))[BASE].token;
	const r = await fetch(`${BASE}/api/v4/projects/${PROJ}/${path}`, {
		method: "POST",
		headers: { "PRIVATE-TOKEN": token, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!r.ok) throw new Error(`API POST ${path} failed: ${r.status}`);
}

try {
	await sleep(4000);
	if (state.loadError) throw new Error(state.loadError);
	await turn(`Call gitlab_fetch once with url ${MR} then stop.`);
	if (!state.toolEnds.some((t) => t.name === "gitlab_fetch" && !t.isError)) throw new Error("fetch failed");
	console.log("✓ fetched");
	await turn(`Call gitlab_watch with action=start, url=${MR}, intervalSeconds=45 then stop.`);
	if (!state.toolEnds.some((t) => t.name === "gitlab_watch" && !t.isError)) throw new Error("watch start failed");
	console.log("✓ watch started (45s)");

	// a whitelisted trigger body posted by hand — silent by policy
	await apiPost(`merge_requests/${IID}/discussions`, { body: "ci test" });
	console.log("✓ posted whitelisted body 'ci test' via API; awaiting one tick of correct silence …");
	const at = state.notices.length;
	await sleep(55000);
	if (state.notices.slice(at).length) throw new Error("watch notified about a whitelisted trigger body — suppression regressed: " + state.notices[at]);
	console.log("✓ silent, as designed");

	// the on-demand answer: list must attribute the suppression
	await turn(`Call gitlab_watch with action list (no url needed) then stop.`);
	const list = state.toolEnds.find((t) => t.name === "gitlab_watch");
	if (!list || list.isError) throw new Error("gitlab_watch list failed: " + (list?.text ?? "no tool end"));
	if (!list.text.includes("whitelist-body")) throw new Error("list did not attribute the whitelist suppression:\n" + list.text.slice(0, 600));
	if (!list.text.includes("healthy")) throw new Error("list did not report watch health:\n" + list.text.slice(0, 600));
	console.log("✓ list attributes the silence:", /healthy[^"\\]{0,90}/.exec(list.text)?.[0] ?? "");

	// a normal comment must still notify
	await apiPost(`merge_requests/${IID}/discussions`, { body: "Attribution e2e — a normal comment that MUST notify." });
	const from = state.notices.length;
	const t1 = Date.now();
	while (state.notices.length === from) {
		if (Date.now() - t1 > 80000) throw new Error("no notification for the normal comment");
		await sleep(2000);
	}
	console.log("✓ normal comment still notified");
	console.log("✅ watch attribution e2e passed");
	child.kill("SIGTERM");
	process.exit(0);
} catch (e) {
	console.error("❌", e.message);
	child.kill("SIGTERM");
	process.exit(1);
}
