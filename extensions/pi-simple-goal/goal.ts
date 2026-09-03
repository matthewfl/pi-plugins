/**
 * Minimal /goal extension.
 *
 * - `/goal <objective>` sets a goal, persists it in the session, and kicks off work.
 * - `/goal` shows the current goal.
 * - `/goal clear` removes the goal.
 * - Injects the active goal into the system prompt on every turn.
 * - When the agent stops without resolving the goal, shows a status-line
 *   countdown ("goal will restart agent in 60s") and re-injects the goal as a
 *   user message once the countdown elapses. Any keypress during the countdown
 *   cancels it and pauses the goal.
 * - Shows a persistent footer status: "goal active", the restart countdown, or
 *   "goal paused (send a message to continue)" after the user interrupted with
 *   Escape or a keypress. Sending a message (or the agent otherwise starting)
 *   auto-resumes the goal and restarts the watchdogs.
 * - Provides `goal_complete` and `goal_impossible` tools so the agent can
 *   finish; each optionally invokes a user-configured notify script as
 *   `script "message from the agent"`.
 * - Reconstructs the active goal from session history on startup, reload, and
 *   branch navigation.
 */

import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	getAgentDir,
	type AgentEndEvent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CUSTOM_TYPE = "simple-goal";
const GOAL_COMPLETE_TOOL = "goal_complete";
const GOAL_IMPOSSIBLE_TOOL = "goal_impossible";
const MIN_REMINDER_INTERVAL_MS = 60_000;
// Window in which an observed Escape keypress is considered the cause of an
// aborted agent_end (user stopped the run on purpose). Outside this window an
// abort is machinery (compaction, ctx.abort(), weird transport) and the goal
// keeps restarting.
const ESCAPE_ABORT_WINDOW_MS = 5_000;
const STATUS_KEY = "simple-goal";

// --- defaults (configurable via flags/env/settings.json "simpleGoal") ---
const WATCHDOG_IDLE_DEFAULT_MS = 5 * 60_000; // 5 min: no activity + no tool running
const WATCHDOG_TOOL_DEFAULT_MS = 30 * 60_000; // 30 min: a single tool has run too long
const WATCHDOG_TICK_DEFAULT_MS = 30_000; // 30 s: how often the watchdog checks
const RESTART_DELAY_DEFAULT_MS = 60_000; // 60 s: delay before auto-restarting the agent

/**
 * Optional extension config in ~/.pi/agent/settings.json:
 *
 * {
 *   "simpleGoal": {
 *     "notifyScript": "~/bin/goal-notify.sh",
 *     "restartDelayMs": 60000,
 *     "watchdogIdleMs": 300000,
 *     "watchdogToolMs": 1800000,
 *     "watchdogTickMs": 30000
 *   }
 * }
 */
interface SimpleGoalSettings {
	notifyScript?: unknown;
	restartDelayMs?: unknown;
	watchdogIdleMs?: unknown;
	watchdogToolMs?: unknown;
	watchdogTickMs?: unknown;
}

function loadSettings(): SimpleGoalSettings {
	try {
		const raw = readFileSync(join(getAgentDir(), "settings.json"), "utf8");
		const json = JSON.parse(raw) as Record<string, unknown>;
		const g = json?.simpleGoal;
		return g && typeof g === "object" ? (g as SimpleGoalSettings) : {};
	} catch {
		return {};
	}
}

function asNum(v: unknown): number | undefined {
	if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
	if (typeof v === "string" && v.trim()) {
		const n = Number(v.trim());
		if (Number.isFinite(n) && n >= 0) return n;
	}
	return undefined;
}

function asStr(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

// Precedence: CLI flag > environment variable > settings.json > default.
function configNum(
	pi: ExtensionAPI,
	flag: string,
	env: string,
	settingsVal: unknown,
	def: number,
): number {
	const f = asNum(pi.getFlag(flag));
	if (f !== undefined) return f;
	const e = asNum(process.env[env]);
	if (e !== undefined) return e;
	const s = asNum(settingsVal);
	if (s !== undefined) return s;
	return def;
}

function configStr(
	pi: ExtensionAPI,
	flag: string,
	env: string,
	settingsVal: unknown,
): string | undefined {
	return (
		asStr(pi.getFlag(flag)) ?? asStr(process.env[env]) ?? asStr(settingsVal)
	);
}

function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

// Raw terminal data for an Escape keypress (legacy, double-escape for /tree,
// and Kitty keyboard protocol CSI-u encodings).
function isEscapeKey(data: string): boolean {
	return data === "\x1b" || data === "\x1b\x1b" || data === "\x1b[27u";
}

interface GoalEntry {
	goal: string;
	id: string;
	setAt: number;
	active: true;
}

interface ClearedGoalEntry {
	active: false;
	clearedAt: number;
}

type StoredGoal = GoalEntry | ClearedGoalEntry;

function isGoalActive(entry: StoredGoal | unknown): entry is GoalEntry {
	return (
		typeof entry === "object" &&
		entry !== null &&
		(entry as StoredGoal).active === true
	);
}

function isGoalCleared(entry: StoredGoal | unknown): entry is ClearedGoalEntry {
	return (
		typeof entry === "object" &&
		entry !== null &&
		(entry as StoredGoal).active === false
	);
}

export default function (pi: ExtensionAPI) {
	let activeGoal: GoalEntry | undefined;
	let lastReminderAt = 0;
	// The goal is paused when the user took manual control (Escape, or any
	// keypress during the restart countdown). Sending a message resumes it.
	let paused = false;
	let lastEscapeAt = 0; // last raw Escape observed via the terminal input listener
	let terminalInputActive = false; // whether onTerminalInput is subscribed (TUI only)

	const settings = loadSettings();

	// Watchdog config (0 disables that check).
	const IDLE_MS = configNum(
		pi,
		"goal-watchdog-idle-ms",
		"PI_GOAL_WATCHDOG_IDLE_MS",
		settings.watchdogIdleMs,
		WATCHDOG_IDLE_DEFAULT_MS,
	);
	const TOOL_MS = configNum(
		pi,
		"goal-watchdog-tool-ms",
		"PI_GOAL_WATCHDOG_TOOL_MS",
		settings.watchdogToolMs,
		WATCHDOG_TOOL_DEFAULT_MS,
	);
	const TICK_MS = configNum(
		pi,
		"goal-watchdog-tick-ms",
		"PI_GOAL_WATCHDOG_TICK_MS",
		settings.watchdogTickMs,
		WATCHDOG_TICK_DEFAULT_MS,
	);
	// Restart countdown (0 disables the delay: restart immediately).
	const RESTART_DELAY_MS = configNum(
		pi,
		"goal-restart-delay-ms",
		"PI_GOAL_RESTART_DELAY_MS",
		settings.restartDelayMs,
		RESTART_DELAY_DEFAULT_MS,
	);
	// Script invoked as `script "message from the agent"` when the goal is
	// marked complete or impossible.
	const NOTIFY_SCRIPT = configStr(
		pi,
		"goal-notify-script",
		"PI_GOAL_NOTIFY_SCRIPT",
		settings.notifyScript,
	);

	let lastActivityAt = 0;
	let sessionCtx: ExtensionContext | undefined;
	const inFlightTools = new Map<string, number>(); // toolCallId -> start ms
	let watchdogTimer: NodeJS.Timeout | undefined;
	let unsubscribeInput: (() => void) | undefined;

	// Restart-countdown state.
	let restartTimer: NodeJS.Timeout | undefined;
	let restartTickTimer: NodeJS.Timeout | undefined;
	let restartDeadlineAt = 0;

	const touchActivity = () => {
		lastActivityAt = Date.now();
	};

	const updateStatus = () => {
		const ctx = sessionCtx;
		if (!ctx?.hasUI) return;
		if (!activeGoal) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		if (restartDeadlineAt > 0) {
			const remaining = Math.max(
				0,
				Math.ceil((restartDeadlineAt - Date.now()) / 1000),
			);
			ctx.ui.setStatus(
				STATUS_KEY,
				`goal will restart agent in ${remaining}s`,
			);
			return;
		}
		if (paused) {
			ctx.ui.setStatus(
				STATUS_KEY,
				"goal paused (send a message to continue)",
			);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, "goal active");
	};

	const cancelRestart = () => {
		if (restartTimer) clearTimeout(restartTimer);
		restartTimer = undefined;
		if (restartTickTimer) clearInterval(restartTickTimer);
		restartTickTimer = undefined;
		restartDeadlineAt = 0;
	};

	const sendContinueMessage = () => {
		if (!activeGoal) return;
		if (sessionCtx && !sessionCtx.isIdle()) return; // something already restarted the agent
		lastReminderAt = Date.now(); // single source of truth for anti-spam spacing
		pi.sendUserMessage(
			`Continue working toward the goal: ${activeGoal.goal}`,
			{ deliverAs: "followUp" },
		);
	};

	const startRestartCountdown = (ctx: ExtensionContext) => {
		cancelRestart();
		const now = Date.now();
		// Anti-spam: restarts are never closer than MIN_REMINDER_INTERVAL_MS
		// apart. When the agent re-stops quickly after an auto-restart (or a
		// shorter delay than that is configured), the restart is DELAYED —
		// never dropped — so the countdown still shows and the goal keeps
		// making progress at the minimum spacing.
		const gateWait =
			lastReminderAt <= 0
				? 0
				: Math.max(0, lastReminderAt + MIN_REMINDER_INTERVAL_MS - now);
		const fireIn = Math.max(RESTART_DELAY_MS, gateWait);
		if (fireIn <= 0 || !ctx.hasUI) {
			// No delay configured (or no UI to show/cancel it): keep the original
			// immediate-continue behavior.
			sendContinueMessage();
			return;
		}
		restartDeadlineAt = now + fireIn;
		updateStatus();
		restartTickTimer = setInterval(updateStatus, 1000);
		restartTimer = setTimeout(() => {
			cancelRestart();
			paused = false;
			touchActivity();
			updateStatus();
			sendContinueMessage();
		}, fireIn);
		for (const t of [restartTimer, restartTickTimer]) {
			if (t && typeof t.unref === "function") t.unref();
		}
	};

	const pauseGoal = () => {
		if (!activeGoal || paused) return;
		paused = true;
		cancelRestart();
		updateStatus();
	};

	// Resume a paused goal: the agent is running (again), so re-arm the
	// watchdogs and show "goal active".
	const resumeGoal = () => {
		if (!activeGoal || !paused) return;
		paused = false;
		lastEscapeAt = 0; // a stale Escape must not justify later machinery aborts
		cancelRestart();
		touchActivity();
		startWatchdog();
		updateStatus();
	};

	const runNotifyScript = (message: string) => {
		if (!NOTIFY_SCRIPT) return;
		const script = expandHome(NOTIFY_SCRIPT);
		pi.exec(script, [message], { timeout: 30_000 })
			.then((res) => {
				if (res.code !== 0) {
					const out = (res.stderr || res.stdout || "").trim();
					sessionCtx?.ui.notify(
						`goal notify script exited ${res.code}${out ? `: ${out.slice(0, 200)}` : ""}`,
						"warning",
					);
				}
			})
			.catch((err) => {
				sessionCtx?.ui.notify(
					`goal notify script failed: ${String(err).slice(0, 200)}`,
					"warning",
				);
			});
	};

	const nudgeGoal = (reason: "idle" | "stuck-tool") => {
		if (!activeGoal || paused) return;
		const now = Date.now();
		if (now - lastReminderAt < MIN_REMINDER_INTERVAL_MS) return;
		lastReminderAt = now;
		const idle = sessionCtx?.isIdle() ?? true;
		const text =
			reason === "stuck-tool"
				? `A tool has been running a long time. Reassess and continue working toward the goal: ${activeGoal.goal}`
				: `You have been idle with an active goal. Continue working toward the goal: ${activeGoal.goal}`;
		if (idle) {
			pi.sendUserMessage(text);
		} else {
			pi.sendUserMessage(text, { deliverAs: "steer" });
		}
		sessionCtx?.ui?.notify?.(`goal-watchdog: ${reason} nudge sent`, "info");
		touchActivity();
	};

	const stopWatchdog = () => {
		if (watchdogTimer) {
			clearInterval(watchdogTimer);
			watchdogTimer = undefined;
		}
	};

	const startWatchdog = () => {
		stopWatchdog();
		if (IDLE_MS <= 0 && TOOL_MS <= 0) return;
		watchdogTimer = setInterval(() => {
			if (!activeGoal || paused) return;
			if (restartDeadlineAt > 0) return; // restart countdown already pending
			const now = Date.now();
			// Long-running tool: agent is blocked on a tool that exceeded TOOL_MS.
			if (TOOL_MS > 0) {
				for (const [id, start] of inFlightTools) {
					if (now - start >= TOOL_MS) {
						nudgeGoal("stuck-tool");
						inFlightTools.set(id, now); // reset; won't re-nudge for another TOOL_MS
						break;
					}
				}
			}
			// Idle: no activity and no tool running for IDLE_MS.
			if (
				IDLE_MS > 0 &&
				inFlightTools.size === 0 &&
				now - lastActivityAt >= IDLE_MS &&
				(sessionCtx?.isIdle() ?? true)
			) {
				nudgeGoal("idle");
			}
		}, TICK_MS);
		if (
			watchdogTimer &&
			typeof (watchdogTimer as NodeJS.Timeout).unref === "function"
		) {
			(watchdogTimer as NodeJS.Timeout).unref();
		}
	};

	pi.registerFlag("goal-watchdog-idle-ms", {
		description: `Nudge the agent after this many ms idle with an active goal (0=off). Default ${WATCHDOG_IDLE_DEFAULT_MS}.`,
		type: "string",
	});
	pi.registerFlag("goal-watchdog-tool-ms", {
		description: `Nudge when a single tool runs longer than this many ms (0=off). Default ${WATCHDOG_TOOL_DEFAULT_MS}.`,
		type: "string",
	});
	pi.registerFlag("goal-watchdog-tick-ms", {
		description: `How often (ms) the goal watchdog checks. Default ${WATCHDOG_TICK_DEFAULT_MS}.`,
		type: "string",
	});
	pi.registerFlag("goal-restart-delay-ms", {
		description: `Delay (ms) before auto-restarting the agent after it stops with an active goal; any keypress cancels and pauses (0=restart immediately). Default ${RESTART_DELAY_DEFAULT_MS}.`,
		type: "string",
	});
	pi.registerFlag("goal-notify-script", {
		description:
			"Script invoked as `script \"message from the agent\"` when the goal is marked complete or impossible.",
		type: "string",
	});

	function buildGoalBlock(goal: GoalEntry): string {
		return [
			"",
			"## Active Goal",
			`Working toward: ${goal.goal}`,
			"- Keep making concrete progress every turn.",
			"- Only ask the user a question if you are genuinely stuck after trying reasonable alternatives.",
			"- When the goal is fully achieved, call the `goal_complete` tool with a brief summary.",
			"- If the goal is impossible or blocked, call the `goal_impossible` tool and explain why.",
		].join("\n");
	}

	async function persistGoal(ctx: ExtensionContext) {
		const entry: StoredGoal = activeGoal
			? { ...activeGoal }
			: { active: false, clearedAt: Date.now() };
		await pi.appendEntry(CUSTOM_TYPE, entry);
	}

	function restoreGoal(ctx: ExtensionContext) {
		// Reconstruct the in-memory goal by replaying every simple-goal custom
		// entry along the current leaf's ancestry, oldest-to-newest, so the last
		// state-change on the branch wins. Mirrors jcode-style-todo's
		// reconstructState(); runs on session_start (reload/resume) and
		// session_tree (branch/navigate).
		activeGoal = undefined;
		const entries = ctx.sessionManager.getEntries();
		const leafId = ctx.sessionManager.getLeafId();
		if (!leafId) return;
		const byId = new Map(entries.map((e) => [e.id, e]));
		const ancestorIds = new Set<string>();
		let id: string | null = leafId;
		while (id) {
			ancestorIds.add(id);
			const entry = byId.get(id);
			id = entry?.parentId ?? null;
		}
		// getEntries() is in append order; filtering to ancestors keeps it
		// chronological along the branch, so replaying lets the recent set/clear win.
		for (const entry of entries) {
			if (!ancestorIds.has(entry.id)) continue;
			if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
			const data = entry.data;
			if (isGoalActive(data)) {
				activeGoal = data;
			} else if (isGoalCleared(data)) {
				activeGoal = undefined;
			}
		}
	}

	const goalCompleteTool = defineTool({
		name: GOAL_COMPLETE_TOOL,
		label: "Goal Complete",
		description:
			"Mark the current /goal as complete. Only call this when the goal has actually been finished.",
		parameters: Type.Object({
			summary: Type.String({
				description:
					"Brief summary of what was completed and how it was verified.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!activeGoal) {
				return {
					content: [{ type: "text", text: "No active goal to complete." }],
					isError: true,
					details: {},
				};
			}
			const completed = activeGoal.goal;
			activeGoal = undefined;
			paused = false;
			cancelRestart();
			updateStatus();
			await persistGoal(ctx);
			runNotifyScript(`Goal completed: ${params.summary}`);
			return {
				content: [{ type: "text", text: `Goal completed: ${params.summary}` }],
				terminate: true,
				details: { completedGoal: completed },
			};
		},
	});

	const goalImpossibleTool = defineTool({
		name: GOAL_IMPOSSIBLE_TOOL,
		label: "Goal Impossible",
		description:
			"Mark the current /goal as impossible or blocked. Explain what is blocking it.",
		parameters: Type.Object({
			reason: Type.String({
				description:
					"Why the goal cannot be completed (e.g., missing access, external dependency).",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!activeGoal) {
				return {
					content: [
						{ type: "text", text: "No active goal to mark impossible." },
					],
					isError: true,
					details: {},
				};
			}
			const abandoned = activeGoal.goal;
			activeGoal = undefined;
			paused = false;
			cancelRestart();
			updateStatus();
			await persistGoal(ctx);
			runNotifyScript(`Goal impossible: ${params.reason}`);
			return {
				content: [
					{
						type: "text",
						text: `Goal abandoned as impossible: ${params.reason}`,
					},
				],
				terminate: true,
				details: { abandonedGoal: abandoned },
			};
		},
	});

	pi.registerTool(goalCompleteTool);
	pi.registerTool(goalImpossibleTool);

	pi.on("session_start", (_event, ctx) => {
		restoreGoal(ctx);
		sessionCtx = ctx;
		lastReminderAt = 0;
		paused = false;
		cancelRestart();
		// Passively observe terminal input: any keypress during the restart
		// countdown cancels it and pauses the goal; Escape pauses too. The
		// listener never consumes input, so typing behaves normally.
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		terminalInputActive = false;
		if (ctx.mode === "tui") {
			unsubscribeInput = ctx.ui.onTerminalInput((data) => {
				terminalInputActive = true;
				if (isEscapeKey(data)) {
					lastEscapeAt = Date.now();
					pauseGoal(); // user stepped in: stop restarting / pause the goal
					return undefined;
				}
				if (!activeGoal || paused) return undefined;
				if (restartDeadlineAt > 0) {
					pauseGoal(); // typing during the restart window cancels it
				}
				return undefined;
			});
			terminalInputActive = true;
		}
		touchActivity();
		startWatchdog();
		updateStatus();
		if (activeGoal && ctx.hasUI) {
			ctx.ui.notify(`Active goal: ${activeGoal.goal}`, "info");
		}
		// A freshly opened/reloaded session with an active goal has no agent_end
		// to trigger the restart countdown, and the idle watchdog only kicks in
		// after watchdogIdleMs (default 5min). Close that gap: if the agent
		// isn't already running (e.g. a mid-run reload), start the standard
		// countdown — the agent restarts after restartDelayMs unless the user
		// intervenes (any keypress cancels it).
		if (activeGoal && !paused && ctx.isIdle() && ctx.hasUI) {
			startRestartCountdown(ctx);
		}
	});

	pi.on("session_tree", (_event, ctx) => {
		// Leaf moved via branching or tree navigation: re-derive the goal from
		// the new branch ancestry so in-memory state tracks the session.
		restoreGoal(ctx);
		sessionCtx = ctx;
		lastReminderAt = 0;
		paused = false;
		cancelRestart();
		updateStatus();
		if (activeGoal && !paused && ctx.isIdle() && ctx.hasUI) {
			startRestartCountdown(ctx);
		}
	});

	pi.on("session_shutdown", () => {
		stopWatchdog();
		cancelRestart();
		inFlightTools.clear();
		unsubscribeInput?.();
		unsubscribeInput = undefined;
	});

	// The agent (re)starting for any reason auto-resumes a paused goal and
	// re-arms the watchdogs, and supersedes any pending restart countdown.
	pi.on("agent_start", (_event, ctx) => {
		sessionCtx = ctx;
		cancelRestart();
		if (activeGoal) {
			if (paused) {
				resumeGoal();
			} else {
				touchActivity();
				startWatchdog();
			}
			updateStatus();
		}
	});

	// Track liveness so the watchdog can detect a stuck/idle agent (the
	// post-compaction stuck state fires no agent_end we can nudge on).
	pi.on("message_update", () => touchActivity());
	pi.on("turn_end", () => touchActivity());
	pi.on("input", () => {
		touchActivity();
		// A submitted message supersedes a pending restart countdown and
		// resumes a paused goal ("send a message to continue").
		cancelRestart();
		resumeGoal();
	});
	pi.on("tool_execution_start", (event: { toolCallId: string }) => {
		inFlightTools.set(event.toolCallId, Date.now());
		touchActivity();
	});
	pi.on("tool_execution_end", (event: { toolCallId: string }) => {
		inFlightTools.delete(event.toolCallId);
		touchActivity();
	});

	pi.registerCommand("goal", {
		description:
			"Set or clear a simple goal: /goal <objective>, /goal clear, /goal show",
		handler: async (args, ctx) => {
			sessionCtx = ctx;
			const text = args.trim();
			if (!text || text === "show") {
				if (activeGoal) {
					ctx.ui.notify(`Current goal: ${activeGoal.goal}`, "info");
				} else {
					ctx.ui.notify("No active goal.", "info");
				}
				return;
			}
			if (text === "clear") {
				activeGoal = undefined;
				paused = false;
				cancelRestart();
				updateStatus();
				await persistGoal(ctx);
				ctx.ui.notify("Goal cleared.", "info");
				return;
			}

			activeGoal = {
				goal: text,
				id: `sg-${Date.now()}`,
				setAt: Date.now(),
				active: true,
			};
			paused = false;
			cancelRestart();
			await persistGoal(ctx);
			touchActivity();
			updateStatus();
			ctx.ui.notify(`Goal set: ${text}`, "info");

			const kickoff = `Goal set: ${text}`;
			if (ctx.isIdle()) {
				pi.sendUserMessage(kickoff);
			} else {
				pi.sendUserMessage(kickoff, { deliverAs: "steer" });
			}
		},
	});

	pi.on("before_agent_start", (event, _ctx) => {
		if (!activeGoal) return;
		return {
			systemPrompt: event.systemPrompt + buildGoalBlock(activeGoal),
		};
	});

	pi.on("agent_end", (event, ctx) => {
		touchActivity();
		sessionCtx = ctx;
		if (!activeGoal) return;
		if (paused) {
			updateStatus();
			return;
		}

		const messages = (event as AgentEndEvent).messages;
		const last = messages[messages.length - 1];
		if (!last || last.role !== "assistant") return;

		const stopReason = (last as any).stopReason;
		if (stopReason === "aborted") {
			const now = Date.now();
			// Pause only on observed user intervention. In the TUI an abort is an
			// intentional stop only when we just saw the Escape keypress; machinery
			// aborts (compaction, ctx.abort(), a transport hiccup that surfaced as
			// "aborted" instead of "error") must NOT silence the goal — they fall
			// through to the restart countdown below. Outside the TUI there is no
			// terminal input stream, so every abort is user-driven (session_abort).
			const sawEscape =
				lastEscapeAt > 0 && now - lastEscapeAt <= ESCAPE_ABORT_WINDOW_MS;
			if (sawEscape || !terminalInputActive) {
				lastEscapeAt = 0; // consumed: one Escape justifies one aborted
				pauseGoal();
				return;
			}
		}

		// If the assistant already invoked a goal tool, tool_execution_end will handle it.
		const anyGoalTool = (last as any).toolCalls?.some(
			(tc: any) =>
				tc.name === GOAL_COMPLETE_TOOL || tc.name === GOAL_IMPOSSIBLE_TOOL,
		);
		if (anyGoalTool) return;

		// Every other stop — "stop", "error" after retries give up, context
		// length, anything unexpected — restarts the agent once the countdown
		// elapses. The goal is only ever finished via goal_complete /
		// goal_impossible (or by the user pausing/discarding it); merely saying
		// "done" in the chat never ends it. If another mechanism (pi-retry,
		// max-tokens continuation, the user) restarts the agent first,
		// agent_start cancels the pending countdown.
		// Any keypress in the meantime cancels the restart and pauses the goal.
		startRestartCountdown(ctx);
	});
}
