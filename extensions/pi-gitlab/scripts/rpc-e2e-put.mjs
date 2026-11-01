#!/usr/bin/env node
/**
 * Fresh-session put-gate e2e (batch review dialog exercised via rpc UI
 * protocol): model fetches (unlock), runs gitlab_put dry_run, then submit;
 * we capture and approve the confirm dialog; afterwards the caller verifies
 * the file state. Requires the batch already staged in the item file.
 */
import { spawn } from "node:child_process";

const FILE = process.env.PI_GITLAB_TEST_ITEM_FILE ?? "the item file path printed by gitlab_fetch";
const MR = process.env.PI_GITLAB_TEST_MR_URL ??
	"https://gitlab.example.com/group/project/-/merge_requests/1"; // set PI_GITLAB_TEST_MR_URL to a real test MR
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
	console.log("--- gate title:", state.confirmTitle);
	console.log("--- gate preview:\n" + (state.confirmPreview ?? "").split("\n").slice(0, 12).join("\n"));
	console.log("✅ put-gate e2e passed");
	child.kill("SIGTERM");
	process.exit(0);
} catch (e) {
	console.error("❌", e.message);
	child.kill("SIGTERM");
	process.exit(1);
}
