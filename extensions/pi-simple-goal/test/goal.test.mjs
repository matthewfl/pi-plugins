// Behavioral tests for goal.ts (run with `npm test`).
//
// Drives the extension with a mocked ExtensionAPI/ExtensionContext and asserts
// on footer status text, restart countdown behavior, pause/resume transitions,
// watchdog pausing, and the goal-complete/impossible notify script invocation.
//
// The harness loads goal.ts with jiti using the same dist aliases pi uses, so
// it exercises the real runtime transform. It needs a pi-coding-agent install
// to resolve @earendil-works/* packages; set PI_CODING_AGENT_DIR to the package
// root, or have `pi` on PATH, to point it at one.

import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const EXT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GOAL_TS = path.join(EXT_DIR, "goal.ts");

function findPiPackageDir() {
	if (process.env.PI_CODING_AGENT_DIR && existsSync(process.env.PI_CODING_AGENT_DIR)) {
		return process.env.PI_CODING_AGENT_DIR;
	}
	// Follow the `pi` binary symlink to its package root.
	try {
		const bin = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
		if (bin) {
			const real = execFileSync("readlink", ["-f", bin], { encoding: "utf8" }).trim();
			// Walk up from the resolved CLI entry to the package root.
			let dir = path.dirname(real);
			for (let i = 0; i < 5; i++) {
				if (existsSync(path.join(dir, "dist", "index.js"))) return dir;
				dir = path.dirname(dir);
			}
		}
	} catch {}
	// Fall back to node resolution from this repo.
	try {
		const req = createRequire(path.join(EXT_DIR, "package.json"));
		return path.dirname(path.dirname(req.resolve("@earendil-works/pi-coding-agent")));
	} catch {}
	throw new Error(
		"Cannot locate @earendil-works/pi-coding-agent. Set PI_CODING_AGENT_DIR to its package root.",
	);
}

const PI_PKG = findPiPackageDir();

function pkgPath(rel) {
	const underPkg = path.join(PI_PKG, "node_modules", rel);
	if (existsSync(underPkg)) return underPkg;
	const sibling = path.join(path.dirname(PI_PKG), rel);
	if (existsSync(sibling)) return sibling;
	throw new Error(`Cannot resolve package path: ${rel}`);
}

const require = createRequire(path.join(PI_PKG, "index.js"));
const { createJiti } = require("jiti");

const aliases = {
	"@earendil-works/pi-coding-agent": path.join(PI_PKG, "dist/index.js"),
	"@earendil-works/pi-agent-core": pkgPath("@earendil-works/pi-agent-core/dist/index.js"),
	"@earendil-works/pi-tui": pkgPath("@earendil-works/pi-tui/dist/index.js"),
	"@earendil-works/pi-ai/providers/all": pkgPath("@earendil-works/pi-ai/dist/providers/all.js"),
	"@earendil-works/pi-ai/compat": pkgPath("@earendil-works/pi-ai/dist/compat.js"),
	"@earendil-works/pi-ai/oauth": pkgPath("@earendil-works/pi-ai/dist/oauth.js"),
	"@earendil-works/pi-ai": pkgPath("@earendil-works/pi-ai/dist/compat.js"),
	typebox: require.resolve("typebox"),
};

const jiti = createJiti(import.meta.url, { moduleCache: false, alias: aliases });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra) {
	if (cond) console.log(`  PASS ${name}`);
	else {
		failures++;
		console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
	}
}

// Fresh extension instance per scenario (env must be set before factory runs).
async function makeWorld({ env = {}, goalActive = true, mode = "tui" } = {}) {
	for (const k of Object.keys(env)) process.env[k] = env[k];
	const factory = await jiti.import(GOAL_TS, { default: true });

	const world = {
		statuses: new Map(),
		sent: [],
		execCalls: [],
		appended: [],
		inputHandler: undefined,
		idle: true,
		handlers: new Map(),
		tools: new Map(),
	};
	const pi = {
		on: (e, fn) => world.handlers.set(e, fn),
		registerFlag: () => {},
		getFlag: () => undefined,
		registerTool: (t) => world.tools.set(t.name, t),
		registerCommand: (name, cmd) => world.handlers.set(`command:${name}`, cmd),
		appendEntry: async (type, data) => {
			world.appended.push({ type, data });
		},
		sendUserMessage: (text, opts) => {
			world.sent.push({ text, opts });
		},
		exec: async (cmd, args) => {
			world.execCalls.push({ cmd, args });
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
	};
	await factory(pi); // factory reads flag/env config; keep env set until now
	for (const k of Object.keys(env)) delete process.env[k];

	const goalEntry = {
		id: "e1",
		parentId: null,
		type: "custom",
		customType: "simple-goal",
		data: goalActive
			? { goal: "test goal", id: "sg-1", setAt: Date.now(), active: true }
			: { active: false, clearedAt: Date.now() },
	};
	world.ctx = {
		hasUI: true,
		mode,
		cwd: "/tmp",
		isIdle: () => world.idle,
		sessionManager: {
			getEntries: () => [goalEntry],
			getLeafId: () => "e1",
		},
		ui: {
			setStatus: (k, t) => {
				if (t === undefined) world.statuses.delete(k);
				else world.statuses.set(k, t);
			},
			notify: () => {},
			onTerminalInput: (fn) => {
				world.inputHandler = fn;
				return () => {
					world.inputHandler = undefined;
				};
			},
		},
	};
	world.start = () => world.handlers.get("session_start")({ reason: "startup" }, world.ctx);
	world.agentEnd = (stopReason, text = "did some work") =>
		world.handlers.get("agent_end")(
			{
				messages: [
					{ role: "assistant", stopReason, content: [{ type: "text", text }] },
				],
			},
			world.ctx,
		);
	world.status = () => world.statuses.get("simple-goal");
	return world;
}

// Scenario 1: countdown appears, keypress cancels -> paused, input -> resumed.
{
	console.log("scenario 1: countdown + keypress pause + input resume");
	const w = await makeWorld({ env: { PI_GOAL_RESTART_DELAY_MS: "1500" } });
	w.start();
	// A session opened with an active goal + idle agent starts the countdown.
	check("status after session_start", /^goal will restart agent in [12]s$/.test(w.status() ?? ""), w.status());
	w.agentEnd("stop");
	check("countdown status", /^goal will restart agent in [12]s$/.test(w.status() ?? ""), w.status());
	w.inputHandler("a"); // any key cancels
	check("paused after keypress", w.status() === "goal paused (send a message to continue)", w.status());
	await sleep(1800);
	check("no continue message after cancel", w.sent.length === 0, JSON.stringify(w.sent));
	await w.handlers.get("input")({ text: "hi", source: "interactive" }, w.ctx);
	check("resumed after input", w.status() === "goal active", w.status());
}

// Scenario 2: countdown elapses -> continue message sent.
{
	console.log("scenario 2: countdown fires continue");
	const w = await makeWorld({ env: { PI_GOAL_RESTART_DELAY_MS: "800" } });
	w.start();
	w.agentEnd("stop");
	await sleep(1200);
	check(
		"continue message sent",
		w.sent.length === 1 && /Continue working toward the goal: test goal/.test(w.sent[0].text),
		JSON.stringify(w.sent),
	);
	check("deliverAs followUp", w.sent[0]?.opts?.deliverAs === "followUp");
	check("status back to active", w.status() === "goal active", w.status());
}

// Scenario 3: escape pauses while idle; aborted agent_end pauses.
{
	console.log("scenario 3: escape + abort pause");
	const w = await makeWorld({ env: { PI_GOAL_RESTART_DELAY_MS: "1500" } });
	w.start();
	w.inputHandler("\x1b");
	check("paused after escape", w.status() === "goal paused (send a message to continue)", w.status());
	await w.handlers.get("input")({ text: "go", source: "interactive" }, w.ctx);
	check("resumed", w.status() === "goal active", w.status());
	// After the resume, an abort with no fresh Escape is machinery: restart.
	w.agentEnd("aborted");
	check("machinery abort restarts", /^goal will restart/.test(w.status() ?? ""), w.status());
	await sleep(1700);
	check("continue after machinery abort", w.sent.length === 1 && /Continue working/.test(w.sent[0].text), JSON.stringify(w.sent));
}

// Scenario 4: goal_complete clears status and runs notify script.
{
	console.log("scenario 4: goal_complete notify");
	const w = await makeWorld({ env: { PI_GOAL_NOTIFY_SCRIPT: "/tmp/notify-test.sh" } });
	w.start();
	const tool = w.tools.get("goal_complete");
	const res = await tool.execute("tc1", { summary: "all done" }, undefined, undefined, w.ctx);
	check("tool terminated", res.terminate === true);
	check("status cleared", w.status() === undefined, w.status());
	await sleep(50);
	check(
		"notify script invoked",
		w.execCalls.length === 1 &&
			w.execCalls[0].cmd === "/tmp/notify-test.sh" &&
			w.execCalls[0].args[0] === "Goal completed: all done",
		JSON.stringify(w.execCalls),
	);
	check("cleared entry appended", w.appended.some((a) => a.data.active === false));
}

// Scenario 5: goal_impossible runs notify script.
{
	console.log("scenario 5: goal_impossible notify");
	const w = await makeWorld({ env: { PI_GOAL_NOTIFY_SCRIPT: "/tmp/notify-test.sh" } });
	w.start();
	const tool = w.tools.get("goal_impossible");
	await tool.execute("tc1", { reason: "blocked on X" }, undefined, undefined, w.ctx);
	await sleep(50);
	check(
		"notify script invoked",
		w.execCalls[0]?.args?.[0] === "Goal impossible: blocked on X",
		JSON.stringify(w.execCalls),
	);
}

// Scenario 6: agent_start supersedes a pending countdown.
{
	console.log("scenario 6: agent_start cancels countdown");
	const w = await makeWorld({ env: { PI_GOAL_RESTART_DELAY_MS: "800" } });
	w.start();
	w.agentEnd("stop");
	check("countdown pending", /^goal will restart/.test(w.status() ?? ""), w.status());
	w.idle = false;
	await w.handlers.get("agent_start")({}, w.ctx);
	await sleep(1100);
	check("no continue after agent_start", w.sent.length === 0, JSON.stringify(w.sent));
	check("status active", w.status() === "goal active", w.status());
}

// Scenario 7: no UI (print mode) -> immediate continue, no countdown.
{
	console.log("scenario 7: print mode immediate continue");
	const w = await makeWorld();
	w.ctx.hasUI = false;
	w.ctx.mode = "print";
	w.start();
	check("no status without UI", w.status() === undefined, w.status());
	w.agentEnd("stop");
	check("immediate continue without UI", w.sent.length === 1, JSON.stringify(w.sent));
}

// Scenario 8: no active goal -> no status, no countdown.
{
	console.log("scenario 8: no goal");
	const w = await makeWorld({ goalActive: false });
	w.start();
	check("no status without goal", w.status() === undefined, w.status());
	w.agentEnd("stop");
	check("no continue without goal", w.sent.length === 0);
}

// Scenario 9: watchdog nudges when idle, stays quiet while paused.
{
	console.log("scenario 9: watchdog respects pause");
	const w = await makeWorld({
		env: {
			PI_GOAL_WATCHDOG_TICK_MS: "50",
			PI_GOAL_WATCHDOG_IDLE_MS: "150",
			PI_GOAL_WATCHDOG_TOOL_MS: "0",
		},
	});
	w.start();
	await w.handlers.get("agent_start")({}, w.ctx); // agent ran: cancels the startup countdown, watchdog takes over
	await sleep(500);
	check("idle nudge sent", w.sent.length === 1 && /idle with an active goal/.test(w.sent[0].text), JSON.stringify(w.sent));
	w.inputHandler("\x1b");
	check("paused", w.status() === "goal paused (send a message to continue)", w.status());
	const before = w.sent.length;
	await sleep(400);
	check("no nudge while paused", w.sent.length === before, JSON.stringify(w.sent));
	await w.handlers.get("session_shutdown")({ reason: "quit" }, w.ctx);
}

// Scenario 10: /goal set shows status; /goal clear removes it.
{
	console.log("scenario 10: /goal set/clear status");
	const w = await makeWorld({ goalActive: false });
	w.start();
	const cmd = w.handlers.get("command:goal");
	await cmd.handler("write tests for foo", w.ctx);
	check("status active after set", w.status() === "goal active", w.status());
	check("kickoff sent", w.sent.length === 1, JSON.stringify(w.sent));
	await cmd.handler("clear", w.ctx);
	check("status cleared after clear", w.status() === undefined, w.status());
}

// Scenario 11: quick re-stop after an auto-restart reschedules the countdown
// (extended to the 60s minimum spacing) instead of going silent.
{
	console.log("scenario 11: anti-spam extends, never drops, the restart");
	const w = await makeWorld({ env: { PI_GOAL_RESTART_DELAY_MS: "800" } });
	w.start();
	w.agentEnd("stop"); // first countdown, fires ~800ms later
	await sleep(1200);
	check("first continue sent", w.sent.length === 1, JSON.stringify(w.sent));
	check("status back to active", w.status() === "goal active", w.status());
	// Agent restarted and quickly stopped again, inside the 60s minimum-spacing
	// window. The restart must be DELAYED (extended countdown), never dropped.
	w.agentEnd("stop");
	check(
		"re-stop still schedules a countdown",
		/^goal will restart agent in \d+s$/.test(w.status() ?? ""),
		w.status(),
	);
	const remaining = Number((w.status() ?? "").match(/(\d+)s$/)?.[1]);
	check(
		"countdown extended to ~60s minimum spacing",
		remaining > 50 && remaining <= 60,
		`remaining=${remaining} status=${w.status()}`,
	);
	// A keypress cancels the extended countdown like any other.
	w.inputHandler("a");
	check("extended countdown still cancellable", w.status() === "goal paused (send a message to continue)", w.status());
}

// Scenario 12: the agent can never fully stop while a goal is active —
// neither by writing "goal complete" in plain text, nor by ending with a
// non-stop reason (error after retries, length). Only goal_complete /
// goal_impossible (or user pause/clear) end the loop.
{
	console.log("scenario 12: no silent stop survives while a goal is active");
	const w = await makeWorld({ env: { PI_GOAL_RESTART_DELAY_MS: "10000" } });
	w.start();
	w.agentEnd("stop", "goal complete, everything is done"); // verbalized completion, no tool call
	check(
		"countdown despite verbalized completion",
		/^goal will restart agent in 10s$/.test(w.status() ?? ""),
		w.status(),
	);
	// Other machinery restarts the agent first (e.g. user message), then the
	// run dies with an error after retries are exhausted: countdown again.
	await w.handlers.get("agent_start")({}, w.ctx); // cancels the pending countdown
	w.agentEnd("error");
	check(
		"countdown after error stop",
		/^goal will restart agent in \d+s$/.test(w.status() ?? ""),
		w.status(),
	);
	await sleep(200);
	check("no early fire", w.sent.length === 0, JSON.stringify(w.sent));
}

// Scenario 13: an aborted agent_end pauses ONLY on observed user intervention
// (recent Escape in the TUI, or non-TUI where aborts are always user-driven).
// Machinery aborts (compaction, ctx.abort()) restart like any other stop.
{
	console.log("scenario 13: abort correlates with Escape, never with machinery");
	// Machinery abort in the TUI (no Escape pressed): restart, don't pause.
	const a = await makeWorld({ env: { PI_GOAL_RESTART_DELAY_MS: "10000" } });
	a.start();
	a.agentEnd("aborted");
	check(
		"machinery abort restarts, not paused",
		a.status() === "goal will restart agent in 10s",
		a.status(),
	);
	// User abort in the TUI: Escape keypress (even during the countdown window).
	a.inputHandler("\x1b");
	check(
		"escape during countdown pauses",
		a.status() === "goal paused (send a message to continue)",
		a.status(),
	);
	// Fresh world: Escape pauses immediately, and the following aborted
	// agent_end (within the correlation window) stays paused.
	const b = await makeWorld({ env: { PI_GOAL_RESTART_DELAY_MS: "10000" } });
	b.start();
	b.inputHandler("\x1b");
	check(
		"escape pauses before abort lands",
		b.status() === "goal paused (send a message to continue)",
		b.status(),
	);
	b.agentEnd("aborted");
	check(
		"aborted after escape stays paused",
		b.status() === "goal paused (send a message to continue)",
		b.status(),
	);
	await sleep(200);
	check("no restart while paused", b.sent.length === 0, JSON.stringify(b.sent));
	// Non-TUI (RPC): no terminal stream exists, every abort is user-driven.
	const c = await makeWorld({ env: { PI_GOAL_RESTART_DELAY_MS: "10000" }, mode: "rpc" });
	c.start();
	check("no input handler in rpc", c.inputHandler === undefined);
	c.agentEnd("aborted");
	check(
		"rpc abort pauses",
		c.status() === "goal paused (send a message to continue)",
		c.status(),
	);
}

// Scenario 14: an opened/reloaded session with an active goal and an idle
// agent schedules the restart countdown immediately (no agent_end needed);
// a mid-run reload (agent not idle) does not. Tree navigation re-checks too.
{
	console.log("scenario 14: session start with goal schedules the countdown");
	const a = await makeWorld({ env: { PI_GOAL_RESTART_DELAY_MS: "1000" } });
	a.start();
	check(
		"countdown from session start",
		a.status() === "goal will restart agent in 1s",
		a.status(),
	);
	await sleep(1200);
	check(
		"continue fires without any agent run",
		a.sent.length === 1 && /Continue working/.test(a.sent[0].text),
		JSON.stringify(a.sent),
	);
	// Mid-run reload (agent still running): stay active, no countdown/message.
	const b = await makeWorld({ env: { PI_GOAL_RESTART_DELAY_MS: "1000" } });
	b.idle = false;
	b.start();
	check("mid-run reload stays active", b.status() === "goal active", b.status());
	await sleep(1200);
	check("no restart while a run is in flight", b.sent.length === 0, JSON.stringify(b.sent));
	// Tree navigation with an active goal re-schedules when idle.
	const c = await makeWorld({ env: { PI_GOAL_RESTART_DELAY_MS: "1000" } });
	c.idle = false; // simulate a run in flight at start: no startup countdown
	c.start();
	c.idle = true;
	await c.handlers.get("session_tree")({}, c.ctx);
	check(
		"countdown after tree navigation",
		c.status() === "goal will restart agent in 1s",
		c.status(),
	);
}

if (failures) {
	console.log(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
