#!/usr/bin/env node
/**
 * Fresh-session watch e2e: the model fetches (unlocking gated tools), lists
 * watches (proves unlock), starts a 45s watch, we post an external comment,
 * and the tick must notify via a [gitlab watch] message in the event stream.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const BASE = process.env.PI_GITLAB_TEST_BASE ?? "https://gitlab.example.com"; // real test instance via env
const MR = process.env.PI_GITLAB_TEST_MR_URL ?? `${BASE}/group/project/-/merge_requests/1`;
// project path for direct API calls, derived from the MR url (no live refs in-repo)
const PROJ = new URL(MR).pathname.split("/-/")[0].slice(1).split("/").map(encodeURIComponent).join("%2F");
const REPO = "/home/matthew/developer/agents";

const child = spawn("pi", ["--mode", "rpc", "--no-session"], { cwd: REPO, env: { ...process.env } });

const state = {
	fetched: false,
	watchListOk: false,
	watchStarted: false,
	watchNotice: null,
	loadError: null,
};
const waiters = [];
function notify(ev) {
	for (const w of waiters.slice()) if (w.pred(ev)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ev); }
}
function waitFor(pred, ms, label) {
	return new Promise((resolve, reject) => {
		const w = { pred, resolve };
		waiters.push(w);
		setTimeout(() => {
			const i = waiters.indexOf(w);
			if (i !== -1) { waiters.splice(i, 1); reject(new Error(`timeout waiting for ${label}`)); }
		}, ms);
	});
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function send(msg) { child.stdin.write(JSON.stringify(msg) + "\n"); }

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
		if (ev.type === "tool_execution_end" && /gitlab_fetch/.test(JSON.stringify(ev)) && !ev.isError) state.fetched = true;
		if (ev.type === "tool_execution_end" && /gitlab_watch/.test(JSON.stringify(ev)) && !ev.isError) state.watchToolOk = true;
		if (/"user"|message_end|agent_start/.test(ev.type) && /\[gitlab watch\]/.test(JSON.stringify(ev))) state.watchNotice = JSON.stringify(ev).slice(0, 500);
		notify(ev);
	}
});
child.stderr.on("data", (d) => { if (/Failed to load extension/.test(String(d))) state.loadError = String(d); });

async function getState() {
	const id = `gs-${Math.random().toString(36).slice(2, 8)}`;
	const p = waitFor((e) => e.type === "response" && e.id === id, 10000, "get_state");
	send({ id, type: "get_state" });
	const ev = await p;
	return ev.data ?? {};
}

async function waitIdle(maxMs = 240000) {
	const t0 = Date.now();
	for (;;) {
		const s = await getState().catch(() => ({}));
		if (s.isStreaming === false) return;
		if (Date.now() - t0 > maxMs) throw new Error("agent stayed streaming too long");
		await sleep(1000);
	}
}

async function prompt(id, message, toolName, expectToolOkLabel) {
	await waitIdle(); // never send mid-stream (rpc rejects prompts while streaming)
	const respP = waitFor((e) => e.type === "response" && e.id === id, 15000, `${id} ack`);
	send({ id, type: "prompt", message });
	const ev = await respP;
	if (!ev.success) throw new Error(`${id} prompt rejected: ${ev.error ?? "unknown"}`);
	if (toolName) {
		await waitFor(
			(e) => e.type === "tool_execution_end" && JSON.stringify(e).includes(toolName) && !e.isError,
			180000,
			`${toolName} execution (${expectToolOkLabel})`,
		);
	}
	await waitIdle();
}

try {
	await sleep(5000);
	if (state.loadError) throw new Error(state.loadError);

	// 1. fetch (unlocks gated tools)
	await prompt("p1", `Call gitlab_fetch once with url ${MR} then stop.`, "gitlab_fetch", "fetch");
	console.log("✓ model called gitlab_fetch (gated tools should now be unlocked)");

	// 2. gated tool visible now? ask for watch list
	await prompt("p2", "Call gitlab_watch once with action=list then stop.", "gitlab_watch", "unlock");
	if (!state.watchToolOk) throw new Error("gitlab_watch call did not succeed");
	console.log("✓ model called gitlab_watch list — staged unlock works");

	// 3. start a fast watch
	await prompt("p3", `Call gitlab_watch with action=start, url=${MR}, intervalSeconds=45 then stop.`, "gitlab_watch", "watch start");
	console.log("✓ watch started (45s interval)");

	// 4. post an external comment as the operator (like a web comment)
	const token = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/gitlab/config/auth.json`, "utf8"))[BASE].token;
	await sleep(20000); // let at least the baseline settle
	const r = await fetch(`${BASE}/api/v4/projects/${PROJ}/merge_requests/1/discussions`, {
		method: "POST",
		headers: { "PRIVATE-TOKEN": token, "content-type": "application/json" },
		body: JSON.stringify({ body: "External comment for watch e2e (posted via API, not through pi)." }),
	});
	if (!r.ok) throw new Error(`posting external comment failed: ${r.status}`);
	console.log("✓ external comment posted; waiting for the tick notification…");

	// 5. the tick should notify via sendUserMessage → shows up in stream
	await waitFor(() => state.watchNotice !== null, 150000, "[gitlab watch] notification");
	console.log("✅ watch tick notification arrived:", state.watchNotice.slice(0, 240));
	console.log("✅ fresh-session watch e2e passed");
	child.kill("SIGTERM");
	process.exit(0);
} catch (e) {
	console.error("❌", e.message);
	child.kill("SIGTERM");
	process.exit(1);
}
