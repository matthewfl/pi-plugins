#!/usr/bin/env node
/**
 * Watch re-arm acceptance (the never-live-verified path): a watch started in
 * one pi process must come back by itself after the process is killed and the
 * session resumed — pollers are reconstructed from session entries, the stale
 * lock (dead pid) is reclaimed, the footer status reappears, and a change on
 * the server still notifies in the NEW process.
 *
 * Phase 1: fresh session file, model fetch + gitlab_watch start, SIGTERM.
 * Phase 2: resume the same session file, watch for the footer status segment,
 *          post an external comment via API, assert the steer notification.
 *
 * No live-instance defaults: set PI_GITLAB_TEST_MR_URL (host, project, iid
 * all derive from it).
 */
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";

const MR = process.env.PI_GITLAB_TEST_MR_URL ?? "https://gitlab.example.com/group/project/-/merge_requests/1";
const BASE = new URL(MR).origin;
const PROJ = new URL(MR).pathname.split("/-/")[0].slice(1).split("/").map(encodeURIComponent).join("%2F");
const IID = new URL(MR).pathname.split("/-/")[1].split("/")[1];
const REPO = "/home/matthew/developer/agents";
const SESSION_DIR = "/tmp/pi-gitlab-rearm";
const SESSION = `${SESSION_DIR}/s1.jsonl`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startPi() {
	const child = spawn("pi", ["--mode", "rpc", "--session", SESSION], { cwd: REPO, env: { ...process.env } });
	const ev = { notices: [], statuses: [], toolEnds: [], turnDone: false, buf: "", loadError: null };
	child.stdout.on("data", (d) => {
		ev.buf += d;
		let i;
		while ((i = ev.buf.indexOf("\n")) !== -1) {
			const line = ev.buf.slice(0, i).trim();
			ev.buf = ev.buf.slice(i + 1);
			if (!line) continue;
			let e;
			try { e = JSON.parse(line); } catch { continue; }
			if (e.type === "extension_ui_request" && e.method === "confirm")
				child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: e.id, confirmed: true }) + "\n");
			if (e.type === "extension_ui_request" && JSON.stringify(e).includes("gitlab: watching"))
				ev.statuses.push(JSON.stringify(e).slice(0, 200));
			if (e.type === "tool_execution_end") ev.toolEnds.push({ name: e.toolName, isError: !!e.isError });
			if (/"user"|message_end/.test(e.type) && /\[gitlab watch\]/.test(JSON.stringify(e))) ev.notices.push(JSON.stringify(e).slice(0, 400));
			if (e.type === "agent_end") ev.turnDone = true;
		}
	});
	child.stderr.on("data", (d) => { if (/Failed to load extension/.test(String(d))) ev.loadError = String(d); });
	return { child, ev };
}

async function turn(child, ev, message, timeoutMs = 240000) {
	ev.toolEnds = []; ev.turnDone = false;
	child.stdin.write(JSON.stringify({ type: "prompt", message }) + "\n");
	const t0 = Date.now();
	while (!ev.turnDone) {
		if (Date.now() - t0 > timeoutMs) throw new Error(`turn never finished (tools: ${ev.toolEnds.map((t) => t.name).join(",") || "none"})`);
		await sleep(1000);
	}
}

try {
	rmSync(SESSION_DIR, { recursive: true, force: true });
	// ── phase 1: start the watch in a real (persistent) session ──
	let p1 = startPi();
	await sleep(4000);
	if (p1.ev.loadError) throw new Error(p1.ev.loadError);
	await turn(p1.child, p1.ev, `Call gitlab_fetch once with url ${MR} then stop.`);
	if (!p1.ev.toolEnds.some((t) => t.name === "gitlab_fetch" && !t.isError)) throw new Error("phase 1: gitlab_fetch failed");
	console.log("✓ phase 1: fetched");
	await turn(p1.child, p1.ev, `Call gitlab_watch with action=start, url=${MR}, intervalSeconds=45 then stop.`);
	if (!p1.ev.toolEnds.some((t) => t.name === "gitlab_watch" && !t.isError)) throw new Error("phase 1: gitlab_watch start failed");
	console.log("✓ phase 1: watch started");
	await sleep(3000); // let the start entry flush to the session file
	p1.child.kill("SIGTERM");
	await new Promise((r) => p1.child.on("exit", r));
	console.log("✓ phase 1: process killed (stale lock left behind)");

	// ── phase 2: resume; the watch must re-arm itself ──
	let p2 = startPi();
	await sleep(4000);
	if (p2.ev.loadError) throw new Error(p2.ev.loadError);
	// footer status proves registerPoller ran in THIS process
	const st0 = Date.now();
	while (!p2.ev.statuses.length) {
		if (Date.now() - st0 > 30000) throw new Error("phase 2: footer status never reappeared — watch did NOT re-arm");
		await sleep(1000);
	}
	console.log("✓ phase 2: footer status reappeared on resume:", p2.ev.statuses[0].slice(0, 120));

	// external change must notify in the resumed process
	const token = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/gitlab/config/auth.json`, "utf8"))[BASE].token;
	const r = await fetch(`${BASE}/api/v4/projects/${PROJ}/merge_requests/${IID}/discussions`, {
		method: "POST",
		headers: { "PRIVATE-TOKEN": token, "content-type": "application/json" },
		body: JSON.stringify({ body: "Re-arm e2e — external comment after pi restart (2026-09-29)." }),
	});
	if (!r.ok) throw new Error(`external comment failed: ${r.status}`);
	console.log("✓ phase 2: external comment posted; awaiting the tick (≤80s) …");
	const from = p2.ev.notices.length;
	const t1 = Date.now();
	while (!p2.ev.notices.slice(from).length) {
		if (Date.now() - t1 > 80000) throw new Error("phase 2: no [gitlab watch] notification after the external comment");
		await sleep(2000);
	}
	console.log("✓ phase 2: notification arrived after restart:", p2.ev.notices[from].slice(0, 160));
	console.log("✅ watch re-arm e2e passed");
	p2.child.kill("SIGTERM");
	await new Promise((r) => p2.child.on("exit", r));
	rmSync(SESSION_DIR, { recursive: true, force: true });
	process.exit(0);
} catch (e) {
	console.error("❌", e.message);
	process.exit(1);
}
