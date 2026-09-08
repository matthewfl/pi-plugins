#!/usr/bin/env node
/**
 * Regression test for the pi-jtodo extension.
 *
 * Suite A: write-time gates, driven deterministically by invoking the todo
 * tool definition directly (no LLM).
 *
 * Suite B: turn-end state machine, driven end-to-end with a scripted mock
 * provider registered via an inline extension factory. Exercises auto-poke,
 * the confidence-spike gate, and cycle completion against a real session.
 *
 * Usage:  node test-todo.cjs
 */
"use strict";

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

let PI_PKG;
try {
	PI_PKG = path.dirname(require.resolve("@earendil-works/pi-coding-agent/package.json"));
} catch {
	// local fallback (pi installed via a node distribution outside this repo)
	PI_PKG = "/home/matthew/down/node-v24.18.0-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent";
}
const pi = require(`${PI_PKG}/dist/index.js`);
const piai = require(`${PI_PKG}/node_modules/@earendil-works/pi-ai/dist/index.js`);

const EXT_DIR = path.join(__dirname, "..", "src");
const EXT_INDEX = path.join(EXT_DIR, "index.ts");

let pass = 0, fail = 0;
const results = [];
function ok(name, detail) { pass++; results.push(`  ✓ ${name}${detail ? " — " + detail : ""}`); }
function bad(name, detail) { fail++; results.push(`  ✗ ${name}${detail ? " — " + detail : ""}`); }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function freshSession(extraLoaderOptions) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jtodo-test-"));
	const loader = new pi.DefaultResourceLoader({
		cwd,
		agentDir: pi.getAgentDir(),
		noExtensions: true, // only our extension keeps the "todo" name unambiguous
		additionalExtensionPaths: [EXT_INDEX],
		...(extraLoaderOptions ?? {}),
	});
	await loader.reload();
	const { session } = await pi.createAgentSession({
		cwd,
		agentDir: pi.getAgentDir(),
		resourceLoader: loader,
		tools: ["todo"],
	});
	return {
		session,
		exec: (params, signal) =>
			session
				.getToolDefinition("todo")
				.execute("test-call", params, undefined, undefined, { sessionManager: session.sessionManager }),
		dispose: () => { try { session.dispose(); } catch {} },
		cwd,
	};
}

async function run(name, fn, extraLoaderOptions) {
	let sess;
	try { sess = await freshSession(extraLoaderOptions); }
	catch (e) { bad(name, `session create failed: ${e.stack ?? e.message}`); return null; }
	try {
		const out = await fn(sess);
		return out;
	} catch (e) {
		bad(name, `threw: ${e.stack ?? e.message}`);
		return null;
	} finally { sess.dispose(); }
}

function lastText(r) { return r.content?.[0]?.text ?? ""; }

// ============================================================================
// Suite A — write-time gates
// ============================================================================

async function suiteA() {
	console.log("\nSuite A: write-time gates (direct tool execute)");

	// T1: bare read on empty state -> empty list, operation read.
	await run("T1 bare read on empty state", async ({ exec }, ) => {
		const r = await exec({});
		const t = lastText(r);
		if (r.details?.operation === "read" && t.trim() === "[]") ok("T1 bare read", "returns []");
		else bad("T1 bare read", `op=${r.details?.operation} text=${t.slice(0, 60)}`);
	});

	// T2: first write saves todos+plan+goals; history seeds once.
	await run("T2 first write saves state + seeds histories", async ({ exec }) => {
		const r = await exec({
			todos: [{ content: "task a", status: "in_progress", priority: "high", id: "a", group: "g", confidence: 70 }],
			plan: { user_intention: "test", understands_user_intent: 85 },
			goals: [{ group: "g", closed_feedback_loop: 80, feedback_loop: "run tests" }],
		});
		const d = r.details;
		const checks = [
			d?.operation === "write",
			d?.todos?.length === 1,
			d?.todos?.[0]?.confidence_history?.join(",") === "70",
			d?.plan?.understands_user_intent_history?.join(",") === "85",
			d?.goals?.[0]?.closed_feedback_loop_history?.join(",") === "80",
		];
		if (checks.every(Boolean)) ok("T2 first write", "state + histories recorded");
		else bad("T2 first write", JSON.stringify({ checks, hist: d?.todos?.[0]?.confidence_history }));
	});

	// T3: replace semantics — omitted ids are gone from the stored list.
	await run("T3 todos replace the list", async ({ exec }) => {
		await exec({ todos: [
			{ content: "a", status: "pending", priority: "low", id: "a", confidence: 50 },
			{ content: "b", status: "pending", priority: "low", id: "b", confidence: 50 },
		] });
		const r = await exec({ todos: [{ content: "b", status: "pending", priority: "low", id: "b", confidence: 50 }] });
		const ids = (r.details?.todos ?? []).map((t) => t.id);
		if (ids.join(",") === "b") ok("T3 replace", "only [b] remains");
		else bad("T3 replace", `ids=${ids.join(",")}`);
	});

	// T4: plan/goals-only write keeps todos, inherits fields, appends history.
	await run("T4 assessment-only write inherits + appends", async ({ exec }) => {
		await exec({
			todos: [{ content: "a", status: "in_progress", priority: "low", id: "a", confidence: 60 }],
			plan: { user_intention: "keep me", understands_user_intent: 70 },
			goals: [{ group: undefined, closed_feedback_loop: 50, feedback_loop: "loop" }],
		});
		const r = await exec({ plan: { user_intention: "", understands_user_intent: 88 } });
		const d = r.details;
		const p = d?.plan;
		const text = lastText(r);
		// "" clears intention per jcode; score history appends; "Plan updates:" shows.
		const checks = [
			d?.todos?.length === 1 && d.todos[0].status === "in_progress",
			p?.user_intention === "",
			p?.understands_user_intent === 88,
			p?.understands_user_intent_history?.join(",") === "70,88",
			text.includes("Plan updates:"),
		];
		if (checks.every(Boolean)) ok("T4 assessment-only", "inherit/append/updates all good");
		else bad("T4 assessment-only", JSON.stringify({ plan: p, hasUpdates: text.includes("Plan updates:") }));
	});

	// T5: ownership gate rejects completing a named group below ownership 96.
	await run("T5 ownership gate rejects whole write", async ({ exec }) => {
		await exec({
			todos: [{ content: "a", status: "in_progress", priority: "low", id: "a", group: "ship", confidence: 90 }],
			goals: [{ group: "ship", closed_feedback_loop: 97, feedback_loop: "tests", end_to_end_ownership: 90 }],
		});
		const r = await exec({ todos: [{ content: "a", status: "completed", priority: "low", id: "a", group: "ship", confidence: 90, completion_confidence: 97 }] });
		const text = lastText(r);
		const after = (await exec({})).details.todos[0];
		const checks = [
			r.details?.operation === "rejected",
			text.includes("end_to_end_ownership"),
			text.includes("unchanged"),
			after?.status === "in_progress",
		];
		if (checks.every(Boolean)) ok("T5 ownership reject", "stored list unchanged, field named");
		else bad("T5 ownership reject", JSON.stringify({ op: r.details?.operation, status: after?.status }));
	});

	// T6: ownership 96 lets the group completion through.
	await run("T6 ownership=96 accepted", async ({ exec }) => {
		await exec({
			todos: [{ content: "a", status: "in_progress", priority: "low", id: "a", group: "ship", confidence: 97 }],
			goals: [{ group: "ship", closed_feedback_loop: 97, feedback_loop: "tests", end_to_end_ownership: 96 }],
		});
		const r = await exec({ todos: [{ content: "a", status: "completed", priority: "low", id: "a", group: "ship", confidence: 97, completion_confidence: 97 }] });
		if (r.details?.operation === "write" && r.details?.todos?.[0]?.status === "completed") ok("T6 ownership pass", "completed");
		else bad("T6 ownership pass", `op=${r.details?.operation} status=${r.details?.todos?.[0]?.status}`);
	});

	// T7: ungrouped completion needs the implicit (group-less) goal's ownership.
	await run("T7 implicit goal ownership for flat list", async ({ exec }) => {
		await exec({ todos: [{ content: "a", status: "in_progress", priority: "low", id: "a", confidence: 97 }] });
		const r1 = await exec({ todos: [{ content: "a", status: "completed", priority: "low", id: "a", confidence: 97, completion_confidence: 97 }] });
		const rejected = r1.details?.operation === "rejected";
		const r2 = await exec({ goals: [{ closed_feedback_loop: 97, feedback_loop: "tests", end_to_end_ownership: 96 }] });
		const r3 = await exec({ todos: [{ content: "a", status: "completed", priority: "low", id: "a", confidence: 97, completion_confidence: 97 }] });
		if (rejected && r2.details?.operation === "write" && r3.details?.operation === "write" && r3.details?.todos?.[0]?.status === "completed") {
			ok("T7 implicit goal", "flat list rejected until implicit ownership");
		} else bad("T7 implicit goal", `r1=${r1.details?.operation} r3=${r3.details?.operation}`);
	});

	// T8: grandfathered groups stay writable (already complete before this write).
	await run("T8 grandfathered completed group", async ({ exec }) => {
		await exec({ goals: [{ group: "done", closed_feedback_loop: 97, feedback_loop: "tests", end_to_end_ownership: 96 }] });
		await exec({ todos: [{ content: "a", status: "completed", priority: "low", id: "a", group: "done", confidence: 97, completion_confidence: 97 }] });
		const r = await exec({
			todos: [{ content: "a", status: "completed", priority: "low", id: "a", group: "done", confidence: 97, completion_confidence: 97 }],
			goals: [{ group: "done", closed_feedback_loop: 97, feedback_loop: "tests" }], // ownership omitted
		});
		// merged goal keeps stored ownership 96 anyway; must also pass even without it
		if (r.details?.operation === "write") ok("T8 grandfathered", "rewrite passes");
		else bad("T8 grandfathered", `op=${r.details?.operation}`);
	});

	// T17: the rejection message is actionable — names the failing group(s),
	// explains what ownership means, and calls out retained goals when the
	// write omitted goal entries (the exact confusion that made agents flail).
	await run("T17 ownership guidance message", async ({ exec }) => {
		await exec({
			todos: [{ content: "a", status: "in_progress", priority: "low", id: "a", group: "alpha", confidence: 90 }],
		});
		// No goals sent at all → rejected, names alpha, warns about retention.
		const r1 = await exec({
			todos: [{ content: "a", status: "completed", priority: "low", id: "a", group: "alpha", confidence: 90, completion_confidence: 97 }],
		});
		const t1 = lastText(r1);
		const named = t1.includes('"alpha"');
		const kept = t1.includes("retained from the previous write");
		const actionable = t1.includes("evidence") && t1.includes("end_to_end_ownership");
		// Goal entry submitted with a low ownership → rejected, names alpha,
		// but does NOT claim it was retained (it was submitted this time).
		const r2 = await exec({
			todos: [{ content: "a", status: "completed", priority: "low", id: "a", group: "alpha", confidence: 90, completion_confidence: 97 }],
			goals: [{ group: "alpha", closed_feedback_loop: 97, feedback_loop: "tests", end_to_end_ownership: 40 }],
		});
		const t2 = lastText(r2);
		const submittedNotBlamed = t2.includes('"alpha"') && !t2.includes("retained from the previous write");
		const r3 = await exec({
			todos: [{ content: "a", status: "completed", priority: "low", id: "a", group: "alpha", confidence: 90, completion_confidence: 97 }],
			goals: [{ group: "alpha", closed_feedback_loop: 97, feedback_loop: "tests", end_to_end_ownership: 96 }],
		});
		if (named && kept && actionable && submittedNotBlamed && r3.details?.operation === "write") {
			ok("T17 ownership guidance", "names group, retention warning conditional, accepts honest claim");
		} else {
			bad("T17 ownership guidance", JSON.stringify({ named, kept, actionable, submittedNotBlamed, final: r3.details?.operation, t1: t1.slice(-360) }, null, 1));
		}
	});

	await run("T18 update-style field inheritance (group + completion_confidence, '' clears)", async ({ exec }) => {
		// proj gets an ownership-96 goal so the gate stays quiet when proj
		// "closes" by move-out in the clear-step write.
		await exec({
			todos: [
				{ id: "g1", content: "grouped", status: "pending", priority: "high", confidence: 90, group: "proj" },
				{ id: "g2", content: "flat", status: "pending", priority: "high", confidence: 90 },
				{ id: "g3", content: "clear me", status: "pending", priority: "high", confidence: 90, group: "proj" },
			],
			goals: [{ group: "proj", closed_feedback_loop: 90, feedback_loop: "x", end_to_end_ownership: 96 }],
		});
		// update-style resend: only status/confidence changed; group omitted
		const r1 = await exec({
			todos: [
				{ id: "g1", content: "grouped", status: "completed", priority: "high", confidence: 92, completion_confidence: 95 },
				{ id: "g2", content: "flat", status: "pending", priority: "high", confidence: 91 },
				{ id: "g3", content: "clear me", status: "pending", priority: "high", confidence: 91 },
			],
		});
		const d1 = r1.details.todos;
		const inherited =
			d1.find((t) => t.id === "g1").group === "proj" &&
			d1.find((t) => t.id === "g1").completion_confidence === 95;
		// later write omits completion_confidence → inherits; "" clears g3's group
		const r2 = await exec({
			todos: [
				{ id: "g1", content: "grouped", status: "completed", priority: "high", confidence: 93 },
				{ id: "g2", content: "flat", status: "pending", priority: "high", confidence: 91 },
				{ id: "g3", content: "clear me", status: "pending", priority: "high", confidence: 91, group: "" },
			],
		});
		const d2 = r2.details.todos;
		const ok2 =
			d2.find((t) => t.id === "g1").completion_confidence === 95 &&
			d2.find((t) => t.id === "g1").group === "proj" &&
			d2.find((t) => t.id === "g2").group === undefined &&
			d2.find((t) => t.id === "g3").group === undefined;
		if (inherited && ok2) ok("T18 field inheritance", "omit inherits, '' clears group");
		else bad("T18 field inheritance", JSON.stringify({ inherited, ok2, d2 }, null, 1).slice(0, 400));
	});

	await run("T19 accepted-write Changes digest", async ({ exec }) => {
		const r1 = await exec({
			todos: [
				{ id: "k1", content: "one", status: "pending", priority: "high", confidence: 90, group: "kg" },
				{ id: "k2", content: "two", status: "pending", priority: "high", confidence: 90, group: "kg" },
				{ id: "k3", content: "three", status: "pending", priority: "high", confidence: 90 },
			],
		});
		const c1 = lastText(r1).includes("Changes: 3 new");
		// edit k1's content, drop k3, resend k2 identical (same confidence →
		// history dedup → zero field delta → not counted as changed)
		const r2 = await exec({
			todos: [
				{ id: "k1", content: "one edited", status: "pending", priority: "high", confidence: 90 },
				{ id: "k2", content: "two", status: "pending", priority: "high", confidence: 90 },
			],
		});
		const t2 = lastText(r2);
		const c2 = t2.includes("1 updated") && t2.includes("removed #k3") && !t2.includes("#k2");
		// clear k1's group (kg stays alive via k2) → the clear is named
		const r3 = await exec({
			todos: [
				{ id: "k1", content: "one edited", status: "pending", priority: "high", confidence: 90, group: "" },
				{ id: "k2", content: "two", status: "pending", priority: "high", confidence: 90 },
			],
		});
		const t3 = lastText(r3);
		const clearedNamed = t3.includes("group cleared on #k1");
		// identical resend → no Changes line at all (quiet on no-op)
		const r4 = await exec({
			todos: [
				{ id: "k1", content: "one edited", status: "pending", priority: "high", confidence: 90 },
				{ id: "k2", content: "two", status: "pending", priority: "high", confidence: 90 },
			],
		});
		const quiet = !lastText(r4).includes("Changes:");
		const detailCarried = r3.details?.item_changes === "group cleared on #k1";
		if (c1 && c2 && clearedNamed && quiet && detailCarried)
			ok("T19 changes digest", "counts updates/additions, names removals/clears, quiet on no-op");
		else
			bad("T19 changes digest", JSON.stringify({ c1, c2, clearedNamed, quiet, detailCarried, t2: t2.slice(-220) }, null, 1));
	});

	// T9: severe first intent -> in-band immediate continuation; second severe write is quiet.
	await run("T9 severe first intent immediate, then deferred", async ({ exec }) => {
		const r1 = await exec({
			todos: [{ content: "a", status: "pending", priority: "low", id: "a", confidence: 50 }],
			plan: { user_intention: "guessing", understands_user_intent: 40 },
		});
		const t1 = lastText(r1);
		const hasImmediate = t1.includes("understanding of the user's intent is not high enough");
		const savedAnyWay = r1.details?.operation === "write";
		const r2 = await exec({ plan: { user_intention: "guessing", understands_user_intent: 41 } });
		const t2 = lastText(r2);
		const quietNow = !t2.includes("understanding of the user's intent is not high enough");
		if (hasImmediate && savedAnyWay && quietNow) ok("T9 severe intent", "immediate once, then deferred");
		else bad("T9 severe intent", JSON.stringify({ hasImmediate, savedAnyWay, quietNow }));
	});

	// T10: confidence history — completion write contributes exactly one entry.
	await run("T10 one history entry per write", async ({ exec }) => {
		await exec({
			todos: [{ content: "a", status: "in_progress", priority: "low", id: "a", group: "g", confidence: 70 }],
			goals: [{ group: "g", closed_feedback_loop: 97, feedback_loop: "x", end_to_end_ownership: 97 }],
		});
		const r = await exec({ todos: [{ content: "a", status: "completed", priority: "low", id: "a", group: "g", confidence: 90, completion_confidence: 97 }] });
		const hist = r.details?.todos?.[0]?.confidence_history;
		if (JSON.stringify(hist) === "[70,97]") ok("T10 history", "[70,97]");
		else bad("T10 history", `hist=${JSON.stringify(hist)}`);
	});

	// T11: lenient normalization via prepareArguments.
	await run("T11 prepareArguments leniency", async ({ session }) => {
		const td = session.getToolDefinition("todo");
		const n = td.prepareArguments({
			todos: "[{\"content\":\"x\",\"status\":\"pending\",\"priority\":\"low\",\"id\":\"x\",\"confidence\":\"85\"}]",
			plan: { user_intention: "y", user_intention_alignment: "97" },
			goals: [{ group: "g", hill_climbability: "88", feedback_loop: "bench" }],
		});
		const checks = [
			Array.isArray(n.todos),
			n.todos[0].confidence === 85,
			n.plan.understands_user_intent === 97,
			n.plan.user_intention_alignment === undefined,
			n.goals[0].closed_feedback_loop === 88,
			n.goals[0].hill_climbability === undefined,
		];
		if (checks.every(Boolean)) ok("T11 normalization", "stringified/aliases coerced");
		else bad("T11 normalization", JSON.stringify(n));
		// empty-string todos becomes absent (a read)
		const n2 = td.prepareArguments({ todos: "" });
		if (n2.todos === undefined) ok("T11b empty string todos -> read", "");
		else bad("T11b empty string todos -> read", JSON.stringify(n2));
	});

	// T12: state survives a fresh session via details replay (reconstruction).
	await run("T12 state reconstruction from branch", async ({ session }) => {
		// state reconstruction is covered implicitly by Suite B sessions; here
		// just assert the tool def exists and is the jcode-style one.
		const td = session.getToolDefinition("todo");
		if (td && typeof td.prepareArguments === "function") ok("T12 tool registered", "pi-jtodo tool present");
		else bad("T12 tool registered", "missing or wrong todo tool");
	});

	// T14: starvation watchdog state machine (fake clock + dep counters).
	await run("T14 watchdog", async () => {
		const { createJiti } = require(`${PI_PKG}/node_modules/jiti/lib/jiti.cjs`);
		const jiti = createJiti(__filename, {
			alias: { "@earendil-works/pi-tui": `${PI_PKG}/node_modules/@earendil-works/pi-tui/dist/index.js` },
		});
		const { createWatchdog } = await jiti.import(path.join(EXT_DIR, "watchdog.ts"));
		let t = 0, armed = true, idle = true, open = 3, aborted = false;
		const fires = [], starves = [];
		const wd = createWatchdog({
			now: () => t,
			isArmed: () => armed,
			isIdle: () => idle,
			incompleteCount: () => open,
			wasAborted: () => aborted,
			idleMs: 90_000,
			maxRePokes: 3,
			onFire: (n) => fires.push(n),
			onStarve: (r) => starves.push(r),
		});
		// fresh start: tick at t0 does nothing (window starts at creation)
		wd.tick();
		// wait past idleMs with everything open+idle+armed -> first re-poke
		t += 91_000; wd.tick();
		// another window -> second re-poke (no activity in between)
		t += 91_000; wd.tick();
		// busy agent postpones
		idle = false; t += 200_000; wd.tick();
		const preBusy = fires.length;
		idle = true; t += 50_000; wd.tick(); // window restarted by busy tick
		const postponed = fires.length === preBusy;
		t += 91_000; wd.tick(); // third re-poke
		t += 91_000; wd.tick(); // cap reached -> starve(cap)
		const capped = starves.join(",") === "cap" && fires.length === 3;
		// activity resets the counter
		starves.length = 0; t += 5_000; wd.notifyActivity(); t += 91_000; wd.tick();
		const resetWorks = fires.length === 4 && fires.at(-1) === 1 && starves.length === 0;
		// settled list means nothing to guard
		open = 0; t += 400_000; wd.tick();
		const settledQuiet = fires.length === 4;
		// abort wins even mid-starvation
		open = 2; aborted = true; t += 400_000; wd.tick();
		const abortWins = starves.join(",") === "aborted";
		// unarmed never fires
		armed = false; aborted = false; t += 400_000; wd.tick();
		const unarmedQuiet = fires.length === 4;
		if (fires[0] === 1 && fires[1] === 2 && postponed && capped && resetWorks && settledQuiet && abortWins && unarmedQuiet) {
			ok("T14 watchdog", "fire/postpone/cap/reset/settled-quiet/abort/unarmed all correct");
		} else {
			bad("T14 watchdog", JSON.stringify({ fires, starves, postponed, capped, resetWorks, settledQuiet, abortWins, unarmedQuiet }));
		}
	});

	// T15: cycle flags derived from the branch walk (reload/tree stability).
	await run("T15 deriveBranchRuntime flags", async () => {
		const { createJiti } = require(`${PI_PKG}/node_modules/jiti/lib/jiti.cjs`);
		const jiti = createJiti(__filename, {
			alias: { "@earendil-works/pi-tui": `${PI_PKG}/node_modules/@earendil-works/pi-tui/dist/index.js` },
		});
		const gates = await jiti.import(path.join(EXT_DIR, "gates.ts"));
		const c = await jiti.import(path.join(EXT_DIR, "constants.ts"));
		const fu = (content) => ({ kind: "followup", content });
		const poke = fu(gates.buildAutoPokeMessage(2));
		const spike = fu(c.TODO_CONFIDENCE_SPIKE_CONTINUATION_MESSAGE);
		const completion = fu(c.TODO_COMPLETION_CONTINUATION_MESSAGE);
		const digest = fu(c.TODO_GATE_DIGEST_PREFIX + " Review.");
		const F = (events) => gates.deriveBranchRuntime(events).flags;
		const emptyOk = JSON.stringify(F([])) === JSON.stringify({ digestDelivered: false, spikeChallenged: false, gateAttempts: 0 });
		const pokesQuiet = JSON.stringify(F([poke, poke])) === JSON.stringify({ digestDelivered: false, spikeChallenged: false, gateAttempts: 0 });
		const f3 = F([spike]);
		const spikeChallenged = f3.spikeChallenged && f3.gateAttempts === 1 && !f3.digestDelivered;
		const f4 = F([digest, completion, completion]);
		const digestAndAttempts = f4.digestDelivered && f4.gateAttempts === 2 && !f4.spikeChallenged;
		// a poke (armed incomplete settle) resets the attempt budget, not the challenge flag
		const f5 = F([spike, poke]);
		const pokeResetsAttempts = f5.spikeChallenged && f5.gateAttempts === 0;
		// real flow: spike challenged twice across two reloads — stays challenged
		const f6 = F([spike, spike, poke, completion]);
		const fullFlow = f6.spikeChallenged && f6.gateAttempts === 1;
		// arbitrary noise (idle nudge / other texts) must not move the flags
		const f7 = F([fu("whatever"), poke]);
		const noiseIgnored = !f7.digestDelivered && !f7.spikeChallenged && f7.gateAttempts === 0;
		// cycle markers (write re-arm / poke on / every disarm) reset the gate
		// flags but not observations: cycle 1's digest+spike must not suppress
		// cycle 2's after a reload mid-cycle-2
		const mk = { kind: "cycle", armed: true };
		const f8 = F([digest, spike, mk, poke]);
		const markerResets = !f8.digestDelivered && !f8.spikeChallenged && f8.gateAttempts === 0;
		const f9 = F([digest, mk, spike]);
		const secondCycleSpikeFires = f9.spikeChallenged && f9.gateAttempts === 1 && !f9.digestDelivered;
		if (emptyOk && pokesQuiet && spikeChallenged && digestAndAttempts && pokeResetsAttempts && fullFlow && noiseIgnored && markerResets && secondCycleSpikeFires) {
			ok("T15 branch flags", "challenge/attempt/digest/marker reconstruction correct");
		} else {
			bad("T15 branch flags", JSON.stringify({ emptyOk, pokesQuiet, spikeChallenged, digestAndAttempts, pokeResetsAttempts, fullFlow, noiseIgnored, markerResets, secondCycleSpikeFires }));
		}
	});

	// T16: pending observations via delta walk — pre-digest scores must not leak back in.
	await run("T16 observation delta walk", async () => {
		const { createJiti } = require(`${PI_PKG}/node_modules/jiti/lib/jiti.cjs`);
		const jiti = createJiti(__filename, {
			alias: { "@earendil-works/pi-tui": `${PI_PKG}/node_modules/@earendil-works/pi-tui/dist/index.js` },
		});
		const gates = await jiti.import(path.join(EXT_DIR, "gates.ts"));
		const c = await jiti.import(path.join(EXT_DIR, "constants.ts"));
		const snap = (openAny, intentHistory, goals = [], confidenceSignature = "sig") => ({ kind: "snapshot", openAny, intentHistory, goals, confidenceSignature });
		const digest = { kind: "followup", content: c.TODO_GATE_DIGEST_PREFIX + " Review." };
		// write1 records intent 88 (<96, open) → 1 observation; write2 climbs to 97 → no new
		let rt = gates.deriveBranchRuntime([snap(true, [88]), snap(true, [88, 97])]);
		const step1 = rt.observations.length === 1 && rt.observations[0].kind === "intent_understanding" && rt.observations[0].score === 88;
		// digest consumes; then write3 dips to 50 and a goal loop scores 80 → 2 observations.
		// CRITICAL: the consumed 88 must NOT come back (contemplator probe).
		rt = gates.deriveBranchRuntime([
			snap(true, [88]), digest,
			snap(true, [88, 97, 50], [{ key: "g", loopHistory: [80, 96] }]),
		]);
		const noLeak = rt.observations.length === 2 &&
			rt.observations.every((o) => o.score !== 88) &&
			rt.observations.some((o) => o.kind === "intent_understanding" && o.score === 50) &&
			rt.observations.some((o) => o.kind === "closed_feedback_loop" && o.score === 80 && o.group === "g") &&
			rt.flags.digestDelivered;
		// settled list (openAny false) records no intent observations
		rt = gates.deriveBranchRuntime([snap(false, [40])]);
		const settledQuiet = rt.observations.length === 0;
		// loop scores recorded even on their own group-snapshot, 96 threshold respected
		rt = gates.deriveBranchRuntime([snap(false, [99], [{ key: null, loopHistory: [95, 96] }])]);
		const loopEdge = rt.observations.length === 1 && rt.observations[0].score === 95;
		if (step1 && noLeak && settledQuiet && loopEdge) {
			ok("T16 observation delta", "append-only diffs, digest clears, no pre-boundary leak");
		} else {
			bad("T16 observation delta", JSON.stringify({ step1, noLeak, settledQuiet, loopEdge }));
		}
	});

	// T17: completion-gate signature — the deadlock detector's identity check.
	await run("T17 completionConfidenceSignature", async () => {
		const { createJiti } = require(`${PI_PKG}/node_modules/jiti/lib/jiti.cjs`);
		const jiti = createJiti(__filename, {
			alias: { "@earendil-works/pi-tui": `${PI_PKG}/node_modules/@earendil-works/pi-tui/dist/index.js` },
		});
		const gates = await jiti.import(path.join(EXT_DIR, "gates.ts"));
		const mk = (id, status, cc) => ({ id, status, completion_confidence: cc });
		const a = [mk("t1", "completed", 95), mk("t2", "pending"), mk("t3", "cancelled", undefined)];
		const sameScoresDifferentOrder = [mk("t3", "cancelled", undefined), mk("t2", "pending"), mk("t1", "completed", 95)];
		const moved = [mk("t1", "completed", 96), mk("t2", "pending"), mk("t3", "cancelled", undefined)];
		const completedChanged = [mk("t1", "in_progress", undefined), mk("t2", "pending"), mk("t3", "cancelled", undefined)];
		const s1 = gates.completionConfidenceSignature(a);
		const orderOK = s1 === gates.completionConfidenceSignature(sameScoresDifferentOrder);
		const movedDiffers = s1 !== gates.completionConfidenceSignature(moved);
		const statusDiffers = s1 !== gates.completionConfidenceSignature(completedChanged);
		const missingMarked = s1.includes("t3:cancelled:-"); // missing score is part of identity
		const openExcluded = !s1.includes("t2:");
		// log-derived challenged signature: a challenge is recoverable after
		// reload when the scores it targeted never moved.
		const c = await jiti.import(path.join(EXT_DIR, "constants.ts"));
		const snapS = (sig) => ({ kind: "snapshot", openAny: false, intentHistory: [], goals: [], confidenceSignature: sig });
		const completion = { kind: "followup", content: c.TODO_COMPLETION_CONTINUATION_MESSAGE };
		const challenged = gates.deriveBranchRuntime([snapS("A"), completion]).lastChallengedSignature === "A";
		const notAfterMove = gates.deriveBranchRuntime([snapS("A"), completion, snapS("B")]).lastChallengedSignature === undefined;
		const resendKeeps = gates.deriveBranchRuntime([snapS("A"), completion, snapS("A"), snapS("A")]).lastChallengedSignature === "A";
		const noChallenge = gates.deriveBranchRuntime([snapS("A")]).lastChallengedSignature === undefined;
		if (orderOK && movedDiffers && statusDiffers && missingMarked && openExcluded && challenged && notAfterMove && resendKeeps && noChallenge) {
			ok("T17 gate signature", "stable under reorder, changes on any gate input; challenged state log-derived");
		} else {
			bad("T17 gate signature", JSON.stringify({ orderOK, movedDiffers, statusDiffers, missingMarked, openExcluded, challenged, notAfterMove, resendKeeps, noChallenge }));
		}
	});

	// T13: above-editor widget line builder (pure, stub theme).
	await run("T13 widget line builder", async () => {
		const { createJiti } = require(`${PI_PKG}/node_modules/jiti/lib/jiti.cjs`);
		const jiti = createJiti(__filename, {
			alias: { "@earendil-works/pi-tui": `${PI_PKG}/node_modules/@earendil-works/pi-tui/dist/index.js` },
		});
		const widget = await jiti.import(path.join(EXT_DIR, "widget.ts"));
		const stubTheme = { fg: (_c, s) => s, bold: (s) => s };
		const mk = (id, status, extra = {}) => ({
			id, content: `content of ${id} purposefully padded to exceed narrow widths`,
			status, priority: "medium", confidence_history: [], ...extra,
		});
		const state = {
			todos: [
				mk("c1", "completed"), mk("a", "in_progress", { group: "g" }), mk("b", "pending"),
				mk("c2", "cancelled"), mk("d", "pending"), mk("e", "completed"), mk("f", "pending"),
			],
			plan: {}, goals: [],
		};
		const rtOn = { armed: true, gateAttempts: 0, gateMaxAttempts: 5 };
		const rtOff = { armed: false, gateAttempts: 0, gateMaxAttempts: 5 };
		const lines = widget.renderTodoWidgetLines(state, rtOn, 6, 60, stubTheme);
		const unescape = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
		// header carries the plan intention (or bare "▣ Todos" when no plan);
		// settled+status moved to the bottom line
		const firstIsHeader = unescape(lines[0]).startsWith("▣ Todos") && !unescape(lines[0]).includes("settled");
		const bottomStatus =
			unescape(lines.at(-1)).includes("3/7 settled") && unescape(lines.at(-1)).includes("auto-poke");
		const inProgressOnTop = unescape(lines[1]).includes("#a");
		const capped = lines.length === 6 && unescape(lines.at(-1)).includes("3 more");
		const hiddenOpenLines = widget.renderTodoWidgetLines(
			{ todos: [1,2,3,4,5,6].map((n) => mk(`p${n}`, "pending")), plan: {}, goals: [] },
			rtOn, 4, 60, stubTheme,
		);
		const openBreakdown = unescape(hiddenOpenLines.at(-1)).includes("(4 open)");
		const withinWidth = lines.every((l) => unescape(l).length <= 60);
		const armedMarker = unescape(lines.at(-1)).includes("auto-poke");
		const empty = widget.renderTodoWidgetLines({ todos: [], plan: {}, goals: [] }, rtOn, 6, 60, stubTheme);
		const unarmed = widget.renderTodoWidgetLines(state, rtOff, 6, 60, stubTheme);
		const offMarker = unescape(unarmed.at(-1)).includes("poke off");
		// Esc-pause label must be distinct from the sticky /todos poke off state.
		const rtEscPaused = { armed: false, escPaused: true, gateAttempts: 0, gateMaxAttempts: 5 };
		const escPausedLine = widget.renderTodoWidgetLines(state, rtEscPaused, 6, 60, stubTheme);
		const escPausedMarker =
			unescape(escPausedLine.at(-1)).includes("poke paused") &&
			!unescape(escPausedLine.at(-1)).includes("poke off");
		// value-rank: shown item lines are exactly a(in_progress), then pending
		// in declaration order; settled items are pushed into the overflow.
		const shownIds = lines.slice(1, -1).map((l) => (unescape(l).match(/#(\w+)/) || [])[1]);
		const ranked = JSON.stringify(shownIds) === JSON.stringify(["a", "b", "d", "f"]);
		// in_progress leads even when declared after pendings/settleds.
		const indented = lines.slice(1).every((l) => l.startsWith("  ")) && !lines[0].startsWith(" ");
		const late = widget.renderTodoWidgetLines(
			{ todos: [mk("p1", "pending"), mk("p2", "pending"), mk("done", "completed"), mk("hot", "in_progress")], plan: {}, goals: [] },
			rtOn, 6, 60, stubTheme,
		);
		const lateLeads = unescape(late[1]).includes("#hot") && unescape(late[2]).includes("#p1");
		// per-item confidence tail: completed shows completion_confidence, open shows confidence
		const confState = { todos: [mk("c", "completed", { completion_confidence: 91 }), mk("o", "pending", { confidence: 72 })], plan: {}, goals: [] };
		const confLines = widget.renderTodoWidgetLines(confState, rtOn, 6, 80, stubTheme).map(unescape);
		const confTails = confLines.some((l) => l.includes("#c") && l.includes("conf 91")) && confLines.some((l) => l.includes("#o") && l.includes("conf 72"));
		// gate countdown on the bottom line while all-settled-but-invalid; done once valid
		const invalidState = { todos: [mk("x", "completed", { completion_confidence: 88 })], plan: {}, goals: [] };
		const cycling = widget.renderTodoWidgetLines(invalidState, { armed: true, gateAttempts: 2, gateMaxAttempts: 5 }, 6, 80, stubTheme).map(unescape);
		const gateShown = cycling.at(-1).includes("gate 2/5");
		const doneState = { todos: [mk("x", "completed", { completion_confidence: 98, priority: "medium" })], plan: {}, goals: [] };
		const doneLines = widget.renderTodoWidgetLines(doneState, rtOff, 6, 80, stubTheme).map(unescape);
		const doneShown = doneLines.at(-1).includes("· done") && !doneLines.at(-1).includes("done · conf");
		// header carries the plan's user intention, truncated to the column,
		// with machine status/counts on the bottom line
		const intentState = { todos: [mk("w1", "pending")], plan: { user_intention: "Review the jcode plan and port the todo extension with tests" }, goals: [] };
		const intentLines = widget.renderTodoWidgetLines(intentState, rtOn, 6, 34, stubTheme).map(unescape);
		const intentShown =
			intentLines[0].startsWith("▣ Todos Review") && intentLines[0].includes("…") && intentLines[0].length <= 34 - 12 &&
			intentLines.at(-1).includes("0/1 settled") && intentLines.at(-1).includes("auto-poke");
		// multiline / whitespace-heavy intentions collapse onto the single header line
		const multiState = { todos: [mk("w1", "pending")], plan: { user_intention: "line one\nline two   spaced" }, goals: [] };
		const multiHeader = unescape(widget.renderTodoWidgetLines(multiState, rtOn, 6, 80, stubTheme)[0]);
		const multiClean = multiHeader.includes("line one line two spaced") && !multiHeader.includes("\n");
		// status icons: passed ✔️, below-the-bar ⚠️, in-progress 🚧
		const iconState = { todos: [mk("ok", "completed", { completion_confidence: 97 }), mk("bad", "completed", { completion_confidence: 88 }), mk("hot", "in_progress")], plan: {}, goals: [] };
		const iconLines = widget.renderTodoWidgetLines(iconState, rtOn, 6, 90, stubTheme).map(unescape);
		const icons = iconLines.some((l) => l.includes("#ok") && l.includes("✔")) &&
			iconLines.some((l) => l.includes("#bad") && l.includes("🟡")) &&
			iconLines.some((l) => l.includes("#hot") && l.includes("🚧"));
		// 👉 finger marks the ids that caused the most recent poke
		const rtPoke = { armed: true, gateAttempts: 0, gateMaxAttempts: 5, pokeTargets: new Set(["b"]) };
		const pokeLines = widget.renderTodoWidgetLines(state, rtPoke, 6, 60, stubTheme).map(unescape);
		const finger = pokeLines.some((l) => l.includes("#b") && l.includes("👉")) &&
			!pokeLines.some((l) => l.includes("#d") && l.includes("👉"));
		// right-hand goals table: spelled-out headers, active group leads,
		// spelled-out score cells, overflow footer, narrow widths drop it
		const goalFixture = {
			todos: [mk("a", "completed", { completion_confidence: 97, group: "verify" }), mk("b", "pending", { group: "builder", confidence: 70 })],
			plan: {},
			goals: [
				{ group: "verify", closed_feedback_loop: 93, end_to_end_ownership: 97, closed_feedback_loop_history: [], end_to_end_ownership_history: [], feedback_loop: "x" },
				{ group: "builder", closed_feedback_loop: 88, feedback_loop: "y", closed_feedback_loop_history: [], end_to_end_ownership_history: [] },
			],
		};
		const tableLines = widget.renderTodoWidgetLines(goalFixture, rtOn, 6, 120, stubTheme).map(unescape);
		const builderRow = tableLines.findIndex((l) => l.includes("builder"));
		const verifyRow = tableLines.findIndex((l) => l.includes("verify"));
		const tableHeader = tableLines.some((l) => l.includes("Todo Goal") && l.includes("Settled") && l.includes("Conf") && l.includes("Own") && l.includes("Feedback"));
		const activeFirst = builderRow > 0 && verifyRow > 0 && builderRow < verifyRow;
		const verifyCells = tableLines[verifyRow].includes("1/1") && tableLines[verifyRow].includes("97%") && tableLines[verifyRow].includes("93%") && tableLines[verifyRow].includes("✔");
		const builderCells = tableLines[builderRow].includes("0/1") && tableLines[builderRow].includes("88%") && tableLines[builderRow].includes("🔲");
		const manyGroups = {
			todos: [1,2,3,4,5,6,7].map((n) => mk(`t${n}`, n === 1 ? "in_progress" : "pending", { group: `grp${n}` })),
			plan: {},
			goals: [1,2,3,4,5,6,7].map((n) => ({ group: `grp${n}`, closed_feedback_loop: 80, feedback_loop: "z", closed_feedback_loop_history: [], end_to_end_ownership_history: [] })),
		};
		const manyLines = widget.renderTodoWidgetLines(manyGroups, rtOn, 6, 120, stubTheme).map(unescape);
		const tableFooter = manyLines.some((l) => l.includes("more group") && l.includes("open"));
		const narrowLines = widget.renderTodoWidgetLines(goalFixture, rtOn, 6, 46, stubTheme).map(unescape);
		const tableDropped = !narrowLines.some((l) => l.includes("Settled")) && narrowLines.every((l) => l.length <= 46);
		// headers and cells share column edges: every table line is the same visible width —
		// across ALL marker classes (✔ pass, 🔲 pending, 🟡 gate-bait, 🚧 active)
		const rawTable = widget.buildGoalsTable(goalFixture, 6, stubTheme).map(unescape);
		const aligned = rawTable.length > 1 && new Set(rawTable.map((l) => l.length)).size === 1;
		const mixedTbl = widget.buildGoalsTable({
			todos: [
				mk("c1", "completed", { completion_confidence: 97, group: "g-ok" }),
				mk("c2", "completed", { completion_confidence: 88, group: "g-warn" }),
				mk("c3", "in_progress", { group: "g-act" }),
				mk("c4", "pending", { group: "g-wait" }),
				mk("c5", "pending", { group: "g-nogoal" }), // group with NO goal entry: must still render ("–" scores)
			], plan: {}, goals: [
				{ group: "g-ok", closed_feedback_loop: 97, end_to_end_ownership: 97, closed_feedback_loop_history: [], end_to_end_ownership_history: [], feedback_loop: "x" },
				{ group: "g-warn", closed_feedback_loop: 97, end_to_end_ownership: 97, closed_feedback_loop_history: [], end_to_end_ownership_history: [], feedback_loop: "x" },
				{ group: "g-act", closed_feedback_loop: 90, closed_feedback_loop_history: [], end_to_end_ownership_history: [], feedback_loop: "x" },
				{ group: "g-wait", closed_feedback_loop: 90, closed_feedback_loop_history: [], end_to_end_ownership_history: [], feedback_loop: "x" },
			] }, 6, stubTheme).map(unescape);
		const markRow = (frag) => mixedTbl.find((l) => l.includes(frag));
		const allAligned = mixedTbl.length === 6 && new Set(mixedTbl.map((l) => l.length)).size === 1 &&
			markRow("g-warn")?.includes("🟡") && markRow("g-ok")?.includes("✔") &&
			markRow("g-act")?.includes("🚧") && markRow("g-wait")?.includes("🔲") &&
			markRow("g-nogoal")?.includes("–");
		if (firstIsHeader && bottomStatus && inProgressOnTop && capped && openBreakdown && withinWidth && armedMarker && ranked && lateLeads && indented && empty.length === 0 && !unescape(unarmed.at(-1)).includes("auto-poke") && offMarker && escPausedMarker && confTails && gateShown && doneShown && intentShown && multiClean && icons && finger && tableHeader && activeFirst && verifyCells && builderCells && tableFooter && tableDropped && aligned && allAligned) {
			ok("T13 widget", "intention header + bottom status + table (Todo Goal) correct");
		} else {
			bad("T13 widget", JSON.stringify({ firstIsHeader, bottomStatus, inProgressOnTop, capped, withinWidth, offMarker, escPausedMarker, confTails, gateShown, doneShown, intentShown, multiClean, icons, finger, tableHeader, activeFirst, verifyCells, builderCells, tableFooter, tableDropped, aligned, allAligned, intentLines, mixedTbl }, null, 1));
		}
	});
}

// ============================================================================
// Suite B — turn-end state machine (scripted mock provider)
// ============================================================================

function makeMockStreamSimple(calls, script) {
	let callIndex = 0;
	return function streamSimple(model, context, options) {
		callIndex += 1;
		calls.push({ index: callIndex, context });
		if (typeof script.onRequest === "function") script.onRequest(context);
		const step = callIndex;
		const scriptCall = script.call;
		const scriptText = script.text;
		const stream = piai.createAssistantMessageEventStream();
		(async () => {
			const output = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "pending",
				timestamp: Date.now(),
			};
		try {
				stream.push({ type: "start", partial: output });
				if (script.gateAt === step) {
					// Hold the stream open so the test can abort mid-flight; honor the
					// abort signal exactly like pi's own providers do (openai-completions.js).
					const signal = options?.signal;
					if (signal?.aborted) throw new Error("Request was aborted");
					await new Promise((resolve, reject) => {
						const onAbort = () => reject(new Error("Request was aborted"));
						signal?.addEventListener("abort", onAbort, { once: true });
						(script.gatePromise || Promise.resolve()).then(
							() => { signal?.removeEventListener("abort", onAbort); resolve(); },
							reject,
						);
					});
				}
				const toolCall = scriptCall(step);
				if (toolCall) {
					output.content.push(toolCall);
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
					stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(toolCall.arguments), partial: output });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
					output.stopReason = "toolUse";
				} else {
					const reply = scriptText(step);
					output.content.push({ type: "text", text: reply });
					stream.push({ type: "text_start", contentIndex: 0, partial: output });
					stream.push({ type: "text_delta", contentIndex: 0, delta: reply, partial: output });
					stream.push({ type: "text_end", contentIndex: 0, content: reply, partial: output });
					output.stopReason = "stop";
				}
				stream.push({ type: "done", reason: output.stopReason, message: output });
				stream.end();
			} catch (err) {
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				// Simulate provider stacks (pi-robust-provider observed live) that
				// finalize an abort as a generic error naming the abort.
				if (script.misclassifiedAbortAt === step) output.stopReason = "error";
				output.errorMessage = err.message;
				stream.push({ type: "error", reason: output.stopReason, error: output });
				stream.end();
			}
		})();
		return stream;
	};
}

const MOCK_MODEL = {
	provider: "mock-pi-jtodo",
	id: "mock-1",
	name: "Mock",
	api: "openai-completions",
	baseUrl: "http://localhost",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 8192,
};

// Scripted conversations (per scenario).
// B1 — poke + spike gate:
//   call 1: create one in_progress todo (aligned plan+goal, spike seed 80)
//   call 2: "done for now"        -> settle#1: auto-poke fires
//   call 3: complete it, cc 97, ownership 97
//   call 4: "all done"            -> settle#2: spike gate fires (Δ80→97 ≥ 15)
//   call 5: "re-validated"        -> settle#3: gates clear, cycle completes
const SCRIPT_B1 = {
	call(step) {
		if (step === 1) {
			return {
				type: "toolCall", id: "call-create", name: "todo",
				arguments: {
					todos: [{ content: "verify rendering pipeline", status: "in_progress", priority: "high", id: "t1", group: "render", confidence: 80 }],
					plan: { user_intention: "e2e turn-end verification", understands_user_intent: 97 },
					goals: [{ group: "render", closed_feedback_loop: 97, feedback_loop: "run the mock suite" }],
				},
			};
		}
		if (step === 3) {
			return {
				type: "toolCall", id: "call-complete", name: "todo",
				arguments: {
					todos: [{ content: "verify rendering pipeline", status: "completed", priority: "high", id: "t1", group: "render", confidence: 80, completion_confidence: 97 }],
					goals: [{ group: "render", closed_feedback_loop: 97, feedback_loop: "run the mock suite", end_to_end_ownership: 97 }],
				},
			};
		}
		return null;
	},
	text(step) {
		if (step === 2) return "Done for now.";
		if (step === 4) return "All wrapped up.";
		if (step === 5) return "Re-ran the suite; results unchanged.";
		return "ok";
	},
	calls: 5,
};

// B2 — deferred digest with late-climb wording:
//   call 1: create in_progress todo with intent 80 (<96, observation)
//   call 2: "working"            -> settle#1: poke
//   call 3: complete + ownership 97 + intent climbs to 97 (late climb)
//   call 4: "done"               -> settle#2: digest (once, late-climb wording)
//   call 5: "rechecked"          -> settle#3: spike gate (Δ80→97)
//   call 6: "verified"           -> settle#4: cycle completes (no 2nd digest)
const SCRIPT_B2 = {
	call(step) {
		if (step === 1) {
			return {
				type: "toolCall", id: "call-create", name: "todo",
				arguments: {
					todos: [{ content: "ambiguous cleanup", status: "in_progress", priority: "medium", id: "t1", confidence: 80 }],
					plan: { user_intention: "half-understood request", understands_user_intent: 80 },
				},
			};
		}
		if (step === 3) {
			return {
				type: "toolCall", id: "call-complete", name: "todo",
				arguments: {
					todos: [{ content: "ambiguous cleanup", status: "completed", priority: "medium", id: "t1", confidence: 80, completion_confidence: 97 }],
					plan: { user_intention: "fully understood now", understands_user_intent: 97 },
					goals: [{ closed_feedback_loop: 97, feedback_loop: "diff the output snapshot", end_to_end_ownership: 97 }],
				},
			};
		}
		return null;
	},
	text(step) {
		if (step === 2) return "Working.";
		if (step === 4) return "Done.";
		if (step === 5) return "Re-checked the earlier work against the request.";
		if (step === 6) return "Verified with fresh evidence.";
		return "ok";
	},
	calls: 6,
};

function contextUserTexts(call) {
	return call.context.messages
		.filter((m) => m.role === "user")
		.map((m) =>
			typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => c.text ?? "").join(""),
		);
}

// B3: a clean cycle disarms; a later write adding open work RE-ARMS the poke
// (the pi-specific deviation that fixed the live 'agent stopped forever' fail).
const SCRIPT_B3 = {
	call(step) {
		if (step === 1) {
			return {
				type: "toolCall", id: "call-open", name: "todo",
				arguments: {
					todos: [{ content: "first wave", status: "in_progress", priority: "high", id: "w1", group: "wave", confidence: 96 }],
					plan: { user_intention: "rearm e2e", understands_user_intent: 97 },
					goals: [{ group: "wave", closed_feedback_loop: 97, feedback_loop: "script asserts pokes" }],
				},
			};
		}
		if (step === 3) {
			return {
				type: "toolCall", id: "call-done", name: "todo",
				arguments: {
					todos: [{ content: "first wave", status: "completed", priority: "high", id: "w1", group: "wave", confidence: 96, completion_confidence: 96 }],
					goals: [{ group: "wave", closed_feedback_loop: 97, feedback_loop: "script asserts pokes", end_to_end_ownership: 96 }],
				},
			};
		}
		if (step === 5) {
			return {
				type: "toolCall", id: "call-reopen", name: "todo",
				arguments: {
					todos: [
						{ content: "first wave", status: "completed", priority: "high", id: "w1", group: "wave", confidence: 96, completion_confidence: 96 },
						{ content: "second wave", status: "in_progress", priority: "high", id: "w2", group: "wave", confidence: 96 },
					],
				},
			};
		}
		if (step === 7) {
			return {
				type: "toolCall", id: "call-done2", name: "todo",
				arguments: {
					todos: [
						{ content: "first wave", status: "completed", priority: "high", id: "w1", group: "wave", confidence: 96, completion_confidence: 96 },
						{ content: "second wave", status: "completed", priority: "high", id: "w2", group: "wave", confidence: 96, completion_confidence: 96 },
					],
					goals: [{ group: "wave", closed_feedback_loop: 97, feedback_loop: "script asserts pokes", end_to_end_ownership: 96 }],
				},
			};
		}
		return null;
	},
	text(step) {
		if (step === 2) return "Wave one done.";
		if (step === 4) return "All wrapped.";
		if (step === 6) return "Adding more work.";
		if (step === 8) return "Really done now.";
		return "ok";
	},
	promptAfter: 4, // clean all-done disarms; the user starts wave two
	promptText: "one more thing to do",
	calls: 8,
};

async function runScenario(name, script, assertions) {
	const calls = [];
	if (script.abortAtCall) {
		// Gate the abortAtCall'th provider call mid-stream so the test can abort
		// the run deterministically while it is in flight.
		script.gateAt = script.abortAtCall;
		script.gatePromise = new Promise((resolve) => {
			script.releaseGate = resolve;
		});
	}
	const mockFactory = {
		name: "mock-provider",
		factory: (api) => {
			api.registerProvider(MOCK_MODEL.provider, {
				name: "Mock",
				baseUrl: MOCK_MODEL.baseUrl,
				apiKey: "mock-key",
				api: MOCK_MODEL.api,
				models: [MOCK_MODEL],
				streamSimple: makeMockStreamSimple(calls, script),
			});
		},
	};
	await run(name, async ({ session }) => {
		await session.setModel(MOCK_MODEL);
		let abortTimerFired = false;
		if (script.abortAtCall) {
			// prompt() resolves only after every queued follow-up run finishes, so
			// the poll loop below can never reach the gated call. Simulate Esc from
			// a timer: abort once the gated provider call has actually started.
			const startedAt = Date.now();
			const abortWhenStarted = () => {
				if (calls.length >= script.abortAtCall) {
					abortTimerFired = true;
					if (script.compactInsteadOfAbort) session.compact();
					else session.abort();
					// Safety net: if the abort somehow never reaches the mock, release
					// the gate so the scenario fails with diagnostics instead of hanging.
					setTimeout(() => { if (script.releaseGate) script.releaseGate(); }, 3000);
				} else if (Date.now() - startedAt < 12_000) {
					setTimeout(abortWhenStarted, 100);
				}
			};
			setTimeout(abortWhenStarted, 300);
		}
		await session.prompt("begin");

		const deadline = Date.now() + 20_000;
		let prompted = false;
		let aborted = false;
		let resumed = false;
		while (Date.now() < deadline) {
			if (!prompted && script.promptAfter && calls.length >= script.promptAfter) {
				prompted = true;
				void session.prompt(script.promptText ?? "continue");
			}
			if (!aborted && script.abortAtCall && calls.length >= script.abortAtCall) {
				aborted = true; // bookkeeping only; the timer above fired the Esc
				if (!abortTimerFired) session.abort();
			}
			if (aborted && !resumed) {
				resumed = true;
				await sleep(1500); // let the abort settle (disarm + quiet) run first
				void session.prompt(script.resumeText ?? "resume after the interrupt");
			}
			if (calls.length >= script.calls) {
				await sleep(800);
				if (calls.length >= script.calls && calls.length <= (script.callsMax ?? script.calls)) break; // done
			}
			await sleep(100);
		}
		const entries = session.sessionManager.getEntries();
		const customs = entries
			.filter((e) => e.type === "custom_message" && e.customType === "pi-jtodo/followup")
			.map((e) => (typeof e.content === "string" ? e.content : ""));
		const inRange = calls.length >= script.calls && calls.length <= (script.callsMax ?? script.calls);
		if (!inRange) {
			bad(`${name} flow`, `expected ${script.calls}${script.callsMax ? `..${script.callsMax}` : ""} provider calls, got ${calls.length}; customs=${JSON.stringify(customs.map((t) => t.slice(0, 60)))}`);
			return;
		}

		const todoResults = entries.filter(
			(e) => e.type === "message" && e.message?.role === "toolResult" && e.message?.toolName === "todo",
		);
		const lastDetails = todoResults.at(-1)?.message?.details;
		await assertions({ calls, customs, lastDetails, entries });
	}, { extensionFactories: [mockFactory] });
}

async function suiteB() {
	console.log("\nSuite B: turn-end state machine (scripted provider)");

	await runScenario("B1 poke -> spike gate -> cycle completes", SCRIPT_B1, async ({ calls, customs, lastDetails }) => {
		const poke = customs.find((t) => t.includes("You have 1 incomplete todo."));
		const spike = customs.find((t) => t.includes("rose too sharply"));
		const digestLeak = customs.find((t) => t.includes("todo quality review"));
		if (!poke) bad("B1 auto-poke followup", `customs=${JSON.stringify(customs)}`);
		else ok("B1 auto-poke followup", "exact poke text as custom message");
		if (!spike) bad("B1 spike gate followup", `customs=${JSON.stringify(customs)}`);
		else ok("B1 spike gate followup", "spike continuation fired once");
		if (digestLeak) bad("B1 no digest without observations", "digest leaked");
		else ok("B1 no digest without observations", "aligned plan recorded nothing");

		// The mock must have SEEN the gate follow-ups as role:"user" messages
		// (jcode's load-bearing user-role property via convertToLlm).
		const users = contextUserTexts(calls[4]);
		if (users.some((t) => t.includes("rose too sharply"))) {
			ok("B1 user-role parity", "gate text reached the model as a user message");
		} else {
			bad("B1 user-role parity", `users=${JSON.stringify(users.slice(-3))}`);
		}

		if (lastDetails?.todos?.[0]?.status === "completed") ok("B1 final todo state", "completed");
		else bad("B1 final todo state", JSON.stringify(lastDetails?.todos));
	});

	await runScenario("B2 deferred digest, late-climb wording, once", SCRIPT_B2, async ({ calls, customs, lastDetails }) => {
		const digests = customs.filter((t) => t.includes("todo quality review"));
		if (digests.length === 1 && digests[0].includes("started this work without understanding")) {
			ok("B2 digest delivered once, late-climb", "exactly one, climb wording");
		} else {
			bad("B2 digest delivered once, late-climb", `digests=${JSON.stringify(digests)}`);
		}
		if (digests.some((t) => /\d+/.test(t.replace(/flagged \d+ times/, "")))) {
			bad("B2 digest hides scores", "numeric leak in digest");
		} else {
			ok("B2 digest hides scores", "no score/threshold numbers");
		}
		const spike = customs.find((t) => t.includes("rose too sharply"));
		if (spike) ok("B2 spike gate after digest", "ordering: digest before gates");
		else bad("B2 spike gate after digest", `customs=${JSON.stringify(customs)}`);
		// digest reached the model as a user message (call 5 is the post-digest turn)
		const users5 = contextUserTexts(calls[4]);
		if (users5.some((t) => t.includes("todo quality review"))) ok("B2 digest user-role", "visible to model");
		else bad("B2 digest user-role", "not in provider context");
		if (lastDetails?.plan?.understands_user_intent_history?.join(",") === "80,97") {
			ok("B2 intent history persisted", "[80,97]");
		} else {
			bad("B2 intent history persisted", JSON.stringify(lastDetails?.plan));
		}
	});

	await runScenario("B3 new open work re-arms the poke", SCRIPT_B3, async ({ customs, lastDetails }) => {
		const pokes = customs.filter((t) => t.includes("You have 1 incomplete todo."));
		if (pokes.length === 2) ok("B3 re-arm poke", "poke #1 after create, poke #2 after re-open");
		else bad("B3 re-arm poke", `poke count=${pokes.length} customs=${JSON.stringify(customs)}`);
		const noisy = customs.filter((t) => t.includes("rose too sharply") || t.includes("not high enough") || t.includes("todo quality review"));
		if (noisy.length === 0) ok("B3 no spurious gates", "clean scores produced no challenges/digest");
		else bad("B3 no spurious gates", JSON.stringify(noisy));
		const done = (lastDetails?.todos ?? []).every((t) => t.status === "completed")
			&& (lastDetails?.todos ?? []).length === 2;
		if (done) ok("B3 final state", "both waves completed");
		else bad("B3 final state", JSON.stringify(lastDetails?.todos));
	});

	// B4: Esc (session.abort) on the poke-driven run must disarm and inject
	// NOTHING afterwards, even though open todos remain. Flow: run A writes an
	// open todo and ends (settle #1 pokes), the poke-driven run B is aborted
	// mid-stream (the user's exact complaint), and both the abort settle and
	// the resumed run's settle stay quiet via the agent_end abort flag.
	// B4: an abort with NO raw Escape behind it is machinery (ctx.abort(),
	// extension-initiated, transport). Under the pi-simple-goal Escape model
	// the poke cycle stays armed: the aborted settle is quiet, but a resumed
	// run that still leaves todos open pokes normally. The real user-Esc pause
	// (raw \x1b keypress) is TUI-only and verified live, not in the SDK harness.
	const SCRIPT_B4 = {
		call(step) {
			if (step === 1) {
				return {
					type: "toolCall", id: "call-open", name: "todo",
					arguments: {
						todos: [{ content: "machinery abort guard", status: "in_progress", priority: "high", id: "e1", group: "esc", confidence: 96 }],
						plan: { user_intention: "machinery abort e2e", understands_user_intent: 97 },
						goals: [{ group: "esc", closed_feedback_loop: 97, feedback_loop: "abort keeps armed" }],
					},
				};
			}
			if (step === 5) {
				return {
					type: "toolCall", id: "call-done", name: "todo",
					arguments: {
						todos: [{ content: "machinery abort guard", status: "completed", priority: "high", id: "e1", group: "esc", confidence: 96, completion_confidence: 96 }],
						goals: [{ group: "esc", closed_feedback_loop: 97, feedback_loop: "abort keeps armed", end_to_end_ownership: 96 }],
					},
				};
			}
			return null;
		},
		text(step) {
			if (step === 2) return "Todos written.";
			if (step === 3) return "Poked: working on it, mid-stream.";
			if (step === 4) return "Resumed after the interrupt, still working.";
			return "All done now.";
		},
		abortAtCall: 3, // abort run B, the poke-driven continuation
		resumeText: "resume after the interrupt",
		calls: 6,
	};
	await runScenario("B4 machinery abort keeps the poke cycle armed", SCRIPT_B4, async ({ customs, entries }) => {
		const pokes = customs.filter((t) => t.includes("You have 1 incomplete todo."));
		if (pokes.length === 2) ok("B4 poke before and after abort", "poke #1 at the write settle, poke #2 after the resumed run — cycle stayed armed");
		else bad("B4 poke before and after abort", `pokes=${pokes.length} customs=${JSON.stringify(customs.map((t) => t.slice(0, 60)))}`);
		if (customs.length === 2) ok("B4 aborted settle quiet", "the abort settle itself injected nothing");
		else bad("B4 aborted settle quiet", `customs=${JSON.stringify(customs.map((t) => t.slice(0, 60)))}`);
		const stopReasons = entries
			.filter((e) => e.type === "message" && e.message?.role === "assistant")
			.map((e) => e.message.stopReason);
		if (stopReasons.includes("aborted")) ok("B4 harness abort recorded", `assistant stopReasons=${JSON.stringify(stopReasons)}`);
		else bad("B4 harness abort recorded", `no aborted stopReason; stopReasons=${JSON.stringify(stopReasons)}`);
	});

	// B5: pi-robust-provider observed live finalizing an Esc abort as a plain
	// error whose text names the abort ("This operation was aborted"). The
	// error-text fallback must classify it as a user interrupt and stay quiet.
	// B5: pi-robust-provider observed live finalizing an Esc abort as a plain
	// error whose text names the abort ("This operation was aborted"). Under
	// the raw-Escape classification model a stopReason mislabel changes
	// NOTHING: with no Escape keypress observed this is machinery, the settle is
	// quiet, and the cycle stays armed. The real-Esc correlation is live-only.
	const SCRIPT_B5 = {
		call(step) {
			if (step === 1) {
				return {
					type: "toolCall", id: "call-open", name: "todo",
					arguments: {
						todos: [{ content: "misclassified abort guard", status: "in_progress", priority: "high", id: "m1", group: "esc", confidence: 96 }],
						plan: { user_intention: "misclassified abort e2e", understands_user_intent: 97 },
						goals: [{ group: "esc", closed_feedback_loop: 97, feedback_loop: "error-naming-abort keeps armed" }],
					},
				};
			}
			if (step === 5) {
				return {
					type: "toolCall", id: "call-done", name: "todo",
					arguments: {
						todos: [{ content: "misclassified abort guard", status: "completed", priority: "high", id: "m1", group: "esc", confidence: 96, completion_confidence: 96 }],
						goals: [{ group: "esc", closed_feedback_loop: 97, feedback_loop: "error-naming-abort keeps armed", end_to_end_ownership: 96 }],
					},
				};
			}
			return null;
		},
		text(step) {
			if (step === 2) return "Todos written.";
			if (step === 3) return "Poked: working, mid-stream.";
			if (step === 4) return "Resumed after the interrupt, still working.";
			return "All done now.";
		},
		abortAtCall: 3,
		misclassifiedAbortAt: 3, // the abort finalizes as stopReason "error" naming the abort
		resumeText: "resume after the interrupt",
		calls: 6,
	};
	await runScenario("B5 error-naming-abort (robust-provider) is machinery", SCRIPT_B5, async ({ customs, entries }) => {
		const pokes = customs.filter((t) => t.includes("You have 1 incomplete todo."));
		if (pokes.length === 2) ok("B5 poke before and after abort", "misclassified abort did not suppress the cycle");
		else bad("B5 poke before and after abort", `pokes=${pokes.length} customs=${JSON.stringify(customs.map((t) => t.slice(0, 60)))}`);
		if (customs.length === 2) ok("B5 aborted settle quiet", "the error-naming-abort settle injected nothing");
		else bad("B5 aborted settle quiet", `customs=${JSON.stringify(customs.map((t) => t.slice(0, 60)))}`);
		const interrupted = entries
			.filter((e) => e.type === "message" && e.message?.role === "assistant")
			.find((e) => /abort/i.test(e.message?.errorMessage ?? ""));
		if (interrupted?.message?.stopReason === "error") ok("B5 interrupt finalized as error", "errorMessage names the abort, stopReason is error");
		else bad("B5 interrupt finalized as error", `stopReason=${interrupted?.message?.stopReason} err=${interrupted?.message?.errorMessage}`);
	});

	// B6: compaction aborts the in-flight run but guarantees a continuation —
	// a system interrupt. Its settle must stay quiet WITHOUT disarming and
	// WITHOUT the sticky Esc off, so the resumed run's settle pokes normally.
	let b6DoneSent = false;
	let b6PokesSeen = 0;
	const SCRIPT_B6 = {
		onRequest(context) {
			// Count auto-poke messages already in the request history; robust
			// to compaction consuming 1 or 2 provider calls. User-role content may
			// be a string or a block array (same extraction as contextUserTexts).
			const texts = (context?.messages ?? [])
				.filter((m) => m?.role === "user")
				.map((m) =>
					typeof m?.content === "string"
						? m.content
						: (m?.content ?? []).map((c) => c?.text ?? "").join(""),
				);
			b6PokesSeen = texts.filter((t) => t.includes("You have 1 incomplete todo.")).length;
		},
		call(step) {
			if (step === 1) {
				return {
					type: "toolCall", id: "call-open", name: "todo",
					arguments: {
						todos: [{ content: "compaction window guard", status: "in_progress", priority: "high", id: "c1", group: "esc", confidence: 96 }],
						plan: { user_intention: "compaction window e2e", understands_user_intent: 97 },
						goals: [{ group: "esc", closed_feedback_loop: 97, feedback_loop: "armed survives compaction" }],
					},
				};
			}
			// Only the run driven by poke #2 completes the todo, so poke #2
			// provably fired (the resumed run before it must leave it open).
			if (step >= 5 && b6PokesSeen >= 2 && !b6DoneSent) {
				b6DoneSent = true;
				return {
					type: "toolCall", id: "call-done", name: "todo",
					arguments: {
						todos: [{ content: "compaction window guard", status: "completed", priority: "high", id: "c1", group: "esc", confidence: 96, completion_confidence: 96 }],
						goals: [{ group: "esc", closed_feedback_loop: 97, feedback_loop: "armed survives compaction", end_to_end_ownership: 96 }],
					},
				};
			}
			return null;
		},
		text(step) {
			if (step === 2) return "Todos written. " + "Detailed work log entries accumulate here. ".repeat(2600);
			if (step === 3) return "Poked: working, mid-stream.";
			return "Continuing after compaction.";
		},
		abortAtCall: 3,
		compactInsteadOfAbort: true, // session.compact() aborts the gated run (system interrupt)
		promptAfter: 4, // after the compaction summarization call, resume the agent
		promptText: "resume the work",
		calls: 7,
		callsMax: 9, // compaction may consume 1 or 2 provider calls
	};
	await runScenario("B6 compaction abort keeps the poke cycle armed", SCRIPT_B6, async ({ customs, entries }) => {
		const pokes = customs.filter((t) => t.includes("You have 1 incomplete todo."));
		if (pokes.length === 2) ok("B6 armed preserved", "poke #1 pre-abort, poke #2 after the resumed run — no sticky-off");
		else bad("B6 armed preserved", `pokes=${pokes.length} customs=${JSON.stringify(customs.map((t) => t.slice(0, 60)))}`);
		const noisy = customs.filter((t) => t.includes("rose too sharply") || t.includes("not high enough") || t.includes("todo quality review"));
		if (noisy.length === 0) ok("B6 no spurious gates", "clean scores produced no challenges/digest");
		else bad("B6 no spurious gates", JSON.stringify(noisy));
		const stopReasons = entries
			.filter((e) => e.type === "message" && e.message?.role === "assistant")
			.map((e) => e.message.stopReason);
		if (stopReasons.includes("aborted")) ok("B6 compaction abort recorded", `stopReasons=${JSON.stringify(stopReasons)}`);
		else bad("B6 compaction abort recorded", `no aborted stopReason; stopReasons=${JSON.stringify(stopReasons)}`);
	});
}

// ============================================================================

async function main() {
	console.log("pi-jtodo regression suite");
	console.log(`extension: ${EXT_INDEX}`);
	await suiteA();
	await suiteB();
	console.log("\n" + "═".repeat(60));
	console.log(`  PASS: ${pass}   FAIL: ${fail}`);
	console.log("═".repeat(60));
	for (const r of results) console.log(r);
	process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
