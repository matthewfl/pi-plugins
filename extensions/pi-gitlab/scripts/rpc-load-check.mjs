#!/usr/bin/env node
/**
 * Bring-up check: load the extension in real pi (RPC mode), drive
 * /gitlab-auth end-to-end against an unreachable instance (warn-but-store
 * path), and assert registration + auth.json side effects.
 *
 * Usage: node scripts/rpc-load-check.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "/home/matthew/developer/agents";
const TEST_HOST = "https://gitlab.example.invalid";
const FAKE_TOKEN = "glpat-FAKE-load-check";

const dataDir = mkdtempSync(join(tmpdir(), "pi-gitlab-loadcheck-"));
const events = [];
let child;
let inputRequestId = null;
let sawAuthNotify = false;
let sawWarnStore = false;
let promptAck = false;
let loadError = null;

function fail(msg) {
	console.error(`❌ ${msg}`);
	dump();
	child?.kill("SIGKILL");
	process.exit(1);
}
function dump() {
	console.error("---- captured events (last 12) ----");
	for (const e of events.slice(-12)) console.error(JSON.stringify(e).slice(0, 400));
}

child = spawn(
	"pi",
	["--offline", "--mode", "rpc", "-e", "extensions/pi-gitlab", "--no-session"],
	{ cwd: REPO, env: { ...process.env, PI_GITLAB_DIR: dataDir } },
);

let buf = "";
child.stdout.on("data", (d) => {
	buf += d;
	let idx;
	while ((idx = buf.indexOf("\n")) !== -1) {
		const line = buf.slice(0, idx).trim();
		buf = buf.slice(idx + 1);
		if (!line) continue;
		let ev;
		try {
			ev = JSON.parse(line);
		} catch {
			events.push({ raw: line });
			continue;
		}
		events.push(ev);
		if (ev.type === "extension_ui_request" && ev.method === "notify") {
			const msg = ev.message ?? ev.params?.message ?? JSON.stringify(ev);
			if (/Personal Access Token/.test(msg)) sawAuthNotify = true;
			if (/stored anyway/i.test(msg)) sawWarnStore = true;
		}
		if (ev.type === "extension_ui_request" && ev.method === "input") {
			inputRequestId = ev.id;
			send({ type: "extension_ui_response", id: ev.id, value: FAKE_TOKEN });
		}
		if (ev.type === "response" && ev.command === "prompt" && ev.id === "req-auth" && ev.success) {
			promptAck = true;
		}
	}
});
child.stderr.on("data", (d) => {
	const s = String(d);
	events.push({ stderr: s });
	if (/Failed to load extension/.test(s)) loadError = s.trim();
});

function send(obj) {
	child.stdin.write(JSON.stringify(obj) + "\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. let everything load
await sleep(4000);
if (loadError) fail(`extension failed to load: ${loadError}`);

// 2. run /gitlab-auth against the unreachable instance
send({ id: "req-auth", type: "prompt", message: `/gitlab-auth ${TEST_HOST}` });

// 3. wait for flow to complete (DNS for .invalid fails fast)
const deadline = Date.now() + 25000;
while (Date.now() < deadline) {
	if (sawWarnStore || (promptAck && sawAuthNotify && inputRequestId && existsSync(join(dataDir, "config", "auth.json")))) break;
	await sleep(250);
}
child.stdin.end();
child.kill("SIGTERM");
await sleep(500);

// ── assertions ───────────────────────────────────────────────────────
const results = [];
const check = (name, cond) => {
	results.push([name, cond]);
	if (!cond) fail(`assertion failed: ${name}`);
};

check("extension loaded (no loader error)", !loadError);
check("/gitlab-auth prompt accepted", promptAck);
check("PAT instructions notify emitted", sawAuthNotify);
check("token input dialog emitted and answered", inputRequestId !== null);
check("unreachable-instance warn-but-store notify emitted", sawWarnStore);

const authFile = join(dataDir, "config", "auth.json");
check("auth.json written", existsSync(authFile));
const auth = JSON.parse(readFileSync(authFile, "utf8"));
check("token stored for host", auth[TEST_HOST]?.token === FAKE_TOKEN);
check("no username when unverified (verified lazily later)", auth[TEST_HOST]?.username === undefined);

console.log(`✅ pi-gitlab RPC load check passed (${results.length} assertions, data dir ${dataDir})`);
process.exit(0);
