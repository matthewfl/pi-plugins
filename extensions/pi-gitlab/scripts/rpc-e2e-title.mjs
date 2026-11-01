#!/usr/bin/env node
/**
 * Fresh-session title-update e2e: with a title rename already staged in the
 * item file (root-tag title="…" differs from the server), the model fetches
 * (unlock), dry-runs, then submits through the confirm gate; the gate preview
 * must show the update-title action line, and afterwards the SERVER title
 * (API gold check with the stored token) must equal the staged one.
 *
 * No live-instance defaults: set PI_GITLAB_TEST_MR_URL and
 * PI_GITLAB_TEST_ITEM_FILE (auth host, project path and iid all derive
 * from the MR url).
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const MR = process.env.PI_GITLAB_TEST_MR_URL ?? "https://gitlab.example.com/group/project/-/merge_requests/1";
// everything (auth key, project path, iid) derives from the MR url itself —
// no separate BASE env to forget
const BASE = new URL(MR).origin;
const FILE = process.env.PI_GITLAB_TEST_ITEM_FILE;
if (!FILE) {
	console.error("set PI_GITLAB_TEST_ITEM_FILE to the item file path gitlab_fetch printed");
	process.exit(64);
}
const PROJ = new URL(MR).pathname.split("/-/")[0].slice(1).split("/").map(encodeURIComponent).join("%2F");
const IID = new URL(MR).pathname.split("/-/")[1].split("/")[1];
// staged title from the file (attr-escaped on disk — unescape for API compare)
const STAGED_TITLE = readFileSync(FILE, "utf8")
	.match(/\stitle="([^"]*)"/)[1]
	.replace(/&quot;/g, '"')
	.replace(/&lt;/g, "<")
	.replace(/&gt;/g, ">")
	.replace(/&amp;/g, "&");
const REPO = "/home/matthew/developer/agents";

const child = spawn("pi", ["--mode", "rpc", "--no-session"], { cwd: REPO, env: { ...process.env } });
const state = { confirmTitle: null, confirmPreview: null, loadError: null };
const waiters = [];
const fire = (ev) => { for (const w of waiters.slice()) if (w.pred(ev)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ev); } };
function waitFor(pred, ms, label) {
	return new Promise((resolve, reject) => {
		const w = { pred, resolve };
		waiters.push(w);
		setTimeout(() => { const i = waiters.indexOf(w); if (i !== -1) { waiters.splice(i, 1); reject(new Error("timeout: " + label)); } }, ms);
	});
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");

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
		if (ev.type === "extension_ui_request" && ev.method === "confirm") {
			state.confirmTitle = ev.title;
			state.confirmPreview = ev.message;
			send({ type: "extension_ui_response", id: ev.id, confirmed: true });
			console.log("✓ confirm gate appeared — auto-approved");
		}
		fire(ev);
	}
});
child.stderr.on("data", (d) => { if (/Failed to load extension/.test(String(d))) state.loadError = String(d); });

async function getState() {
	const id = `gs-${Math.random().toString(36).slice(2, 8)}`;
	const p = waitFor((e) => e.type === "response" && e.id === id, 10000, "get_state");
	send({ id, type: "get_state" });
	return (await p).data ?? {};
}
async function waitIdle(maxMs = 240000) {
	const t0 = Date.now();
	for (;;) {
		const s = await getState().catch(() => ({}));
		if (s.isStreaming === false) return;
		if (Date.now() - t0 > maxMs) throw new Error("streaming too long");
		await sleep(1000);
	}
}
async function prompt(id, message, toolName, timeoutMs = 240000) {
	await waitIdle();
	const respP = waitFor((e) => e.type === "response" && e.id === id, 15000, id + " ack");
	send({ id, type: "prompt", message });
	const ev = await respP;
	if (!ev.success) throw new Error(`${id} rejected: ${ev.error ?? "unknown"}`);
	if (toolName) {
		await waitFor((e) => e.type === "tool_execution_end" && JSON.stringify(e).includes(toolName) && !e.isError, timeoutMs, toolName);
	}
	await waitIdle();
}

try {
	await sleep(5000);
	if (state.loadError) throw new Error(state.loadError);
	await prompt("p1", `Call gitlab_fetch once with url ${MR} then stop.`, "gitlab_fetch");
	console.log("✓ fetch (unlock)");
	await prompt("p2", `Call gitlab_put once with path "${FILE}" and mode "dry_run" then stop.`, "gitlab_put");
	console.log("✓ dry_run via model");
	await prompt("p3", `Call gitlab_put once with path "${FILE}" and mode "submit" then stop.`, "gitlab_put", 300000);
	console.log("✓ submit completed");
	if (!state.confirmTitle) throw new Error("confirm gate never appeared during submit");
	if (!state.confirmPreview.includes("update title")) throw new Error("gate preview lacks the update-title line:\n" + state.confirmPreview);
	console.log("--- gate title:", state.confirmTitle);
	console.log("--- gate preview line:", state.confirmPreview.split("\n").find((l) => l.includes("update title")));
	// API gold check: the server must now carry the staged title
	const token = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/gitlab/config/auth.json`, "utf8"))[BASE].token;
	const r = await fetch(`${BASE}/api/v4/projects/${PROJ}/merge_requests/${IID}`, { headers: { "PRIVATE-TOKEN": token } });
	const serverTitle = (await r.json()).title;
	if (serverTitle !== STAGED_TITLE) throw new Error(`server title ${JSON.stringify(serverTitle)} !== staged ${JSON.stringify(STAGED_TITLE)}`);
	console.log(`✓ server title now: ${JSON.stringify(serverTitle)}`);
	console.log("✅ title-update e2e passed");
	child.kill("SIGTERM");
	process.exit(0);
} catch (e) {
	console.error("❌", e.message);
	child.kill("SIGTERM");
	process.exit(1);
}
