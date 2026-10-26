#!/usr/bin/env node
/**
 * Watch description-change acceptance (fresh RPC session, linear driving):
 * after a watch is running on !1 —
 *   A) a description change submitted BY THE AGENT (gitlab_put) must NOT
 *      notify (the poller is re-primed on submit) — assert silence ≥2 ticks;
 *   B) a description change PATCHed via the API MUST notify
 *      ("description updated").
 * Same auth.json as the other e2e drivers.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseDocument, serializeDocument } from "../format.ts";
import { parseGitLabUrl } from "../url.ts";
import { itemFilePath } from "../paths.ts";

const BASE = process.env.PI_GITLAB_TEST_BASE ?? "https://gitlab.example.com";
const MR = process.env.PI_GITLAB_TEST_MR_URL ?? `${BASE}/group/project/-/merge_requests/1`;
// project path for direct API calls, derived from the MR url (no live refs in-repo)
const PROJ = new URL(MR).pathname.split("/-/")[0].slice(1).split("/").map(encodeURIComponent).join("%2F");
const REPO = "/home/matthew/developer/agents";

const child = spawn("pi", ["--mode", "rpc", "--no-session"], { cwd: REPO, env: { ...process.env } });
let buf = "";
let toolEnds = []; // { name, isError }
const notices = []; // texts of [gitlab watch] messages observed
let turnDone = false;
child.stdout.on("data", (d) => {
	buf += d;
	const lines = buf.split("\n"); buf = lines.pop();
	for (const line of lines) {
		if (!line.trim()) continue;
		let ev; try { ev = JSON.parse(line); } catch { continue; }
		if (ev.type === "extension_ui_request" && ev.method === "confirm")
			child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: ev.id, confirmed: true }) + "\n");
		if (ev.type === "tool_execution_end") toolEnds.push({ name: ev.toolName, isError: !!ev.isError, text: JSON.stringify(ev).slice(0, 400) });
		if (/"user"|message_end/.test(ev.type) && /\[gitlab watch\]/.test(JSON.stringify(ev))) notices.push(JSON.stringify(ev).slice(0, 500));
		if (ev.type === "agent_end") turnDone = true;
	}
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function turn(message, timeoutMs = 240000) {
	toolEnds = []; turnDone = false;
	child.stdin.write(JSON.stringify({ type: "prompt", message }) + "\n");
	const t0 = Date.now();
	while (!turnDone) {
		if (Date.now() - t0 > timeoutMs) throw new Error(`turn never finished within ${timeoutMs / 1000}s (tools seen: ${toolEnds.map((t) => t.name).join(",") || "none"})`);
		await sleep(1000);
	}
	return toolEnds;
}

try {
	await sleep(4000);
	// 1. fetch (unlocks gated tools)
	let ends = await turn(`Call gitlab_fetch once with url ${MR} then stop.`);
	if (!ends.some((t) => t.name === "gitlab_fetch" && !t.isError)) throw new Error(`gitlab_fetch did not succeed: ${JSON.stringify(ends)}`);
	console.log("✓ fetched");

	// 2. start a 45s watch
	ends = await turn(`Call gitlab_watch with action=start, url=${MR}, intervalSeconds=45 then stop.`);
	if (!ends.some((t) => t.name === "gitlab_watch" && !t.isError)) throw new Error("gitlab_watch start failed");
	console.log("✓ watch started (45s)");

	// 3. stage a description edit + submit through the agent
	const ref = parseGitLabUrl(MR);
	if (!ref.ok) throw new Error("bad MR url");
	const itemFile = itemFilePath(ref.ref);
	const stagedBody = `e2e-desc-self-${Date.now()} — staged by the agent; the running watch must stay SILENT about this change.`;
	const doc = parseDocument(readFileSync(itemFile, "utf8"));
	const desc = doc.blocks.find((b) => b.type === "description");
	if (!desc) throw new Error("no <description> block in item file");
	desc.body = stagedBody;
	writeFileSync(itemFile, serializeDocument(doc));
	console.log("✓ staged description edit in the item file");
	ends = await turn("Run gitlab_put on that fetched item file with mode submit, then stop.", 300000);
	if (!ends.some((t) => t.name === "gitlab_put" && !t.isError)) throw new Error(`gitlab_put failed: ${JSON.stringify(ends)}`);
	if (!ends.find((t) => t.name === "gitlab_put").text.includes("1 posted")) throw new Error("unexpected put result: " + ends.find((t) => t.name === "gitlab_put").text.slice(0, 300));
	console.log("✓ description submitted through the agent");

	// A) ≥2 ticks of silence about the description (re-primed)
	const at = notices.length;
	console.log("… 140s silence window (regression: self-notify) …");
	await sleep(140000);
	const selfHit = notices.slice(at).find((t) => t.includes("description updated"));
	if (selfHit) throw new Error(`SELF-NOTIFY REGRESSION: watch fired on our own submit → ${selfHit.slice(0, 220)}`);
	console.log("✓ watch stayed silent about our own submit");

	// B) external API PATCH must notify
	const token = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/gitlab/config/auth.json`, "utf8"))[BASE].token;
	const apiBody = `e2e-desc-api-${Date.now()} — patched externally via the API; the watch MUST notify.`;
	const r = await fetch(`${BASE}/api/v4/projects/${PROJ}/merge_requests/1`, {
		method: "PUT", headers: { "PRIVATE-TOKEN": token, "content-type": "application/json" },
		body: JSON.stringify({ description: apiBody }),
	});
	if (!r.ok) throw new Error(`API PATCH failed: ${r.status}`);
	console.log("✓ description PATCHed via API; awaiting the tick (≤100s) …");
	const from = notices.length;
	const t0 = Date.now();
	while (!notices.slice(from).some((t) => t.includes("description updated"))) {
		if (Date.now() - t0 > 100000) throw new Error(`no 'description updated' within 100s after API PATCH (notices: ${JSON.stringify(notices.slice(from))})`);
		await sleep(2000);
	}
	console.log("✅ 'description updated' notification arrived for the external edit");
	console.log("✅ watch description-change e2e passed");
	child.kill("SIGTERM");
	process.exit(0);
} catch (e) {
	console.error("❌", e.message);
	child.kill("SIGTERM");
	process.exit(1);
}
