/**
 * Minimal /goal extension.
 *
 * - `/goal <objective>` sets a goal, persists it in the session, and kicks off work.
 * - `/goal` shows the current goal.
 * - `/goal clear` removes the goal.
 * - Injects the active goal into the system prompt on every turn.
 * - Re-injects the goal as a user message when the agent stops without resolving it.
 * - Provides `goal_complete` and `goal_impossible` tools so the agent can finish.
 * - Reconstructs the active goal from session history on startup, reload, and branch navigation.
 */

import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type AgentEndEvent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "simple-goal";
const GOAL_COMPLETE_TOOL = "goal_complete";
const GOAL_IMPOSSIBLE_TOOL = "goal_impossible";
const MIN_REMINDER_INTERVAL_MS = 60_000;

// --- watchdog defaults (configurable via flags/env) ---
const WATCHDOG_IDLE_DEFAULT_MS = 5 * 60_000; // 5 min: no activity + no tool running
const WATCHDOG_TOOL_DEFAULT_MS = 30 * 60_000; // 30 min: a single tool has run too long
const WATCHDOG_TICK_DEFAULT_MS = 30_000; // 30 s: how often the watchdog checks

function watchdogNum(
	pi: ExtensionAPI,
	flag: string,
	env: string,
	def: number,
): number {
	const f = pi.getFlag(flag);
	if (typeof f === "string" && f.trim()) {
		const n = Number(f.trim());
		if (Number.isFinite(n) && n >= 0) return n;
	}
	const e = process.env[env];
	if (e && e.trim()) {
		const n = Number(e.trim());
		if (Number.isFinite(n) && n >= 0) return n;
	}
	return def;
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

	// Watchdog config (0 disables that check).
	const IDLE_MS = watchdogNum(
		pi,
		"goal-watchdog-idle-ms",
		"PI_GOAL_WATCHDOG_IDLE_MS",
		WATCHDOG_IDLE_DEFAULT_MS,
	);
	const TOOL_MS = watchdogNum(
		pi,
		"goal-watchdog-tool-ms",
		"PI_GOAL_WATCHDOG_TOOL_MS",
		WATCHDOG_TOOL_DEFAULT_MS,
	);
	const TICK_MS = watchdogNum(
		pi,
		"goal-watchdog-tick-ms",
		"PI_GOAL_WATCHDOG_TICK_MS",
		WATCHDOG_TICK_DEFAULT_MS,
	);

	let lastActivityAt = 0;
	let sessionCtx: ExtensionContext | undefined;
	const inFlightTools = new Map<string, number>(); // toolCallId -> start ms
	let watchdogTimer: NodeJS.Timeout | undefined;

	const touchActivity = () => {
		lastActivityAt = Date.now();
	};

	const nudgeGoal = (reason: "idle" | "stuck-tool") => {
		if (!activeGoal) return;
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
			if (!activeGoal) return;
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
			await persistGoal(ctx);
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
			await persistGoal(ctx);
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
		touchActivity();
		startWatchdog();
		if (activeGoal && ctx.hasUI) {
			ctx.ui.notify(`Active goal: ${activeGoal.goal}`, "info");
		}
	});

	pi.on("session_tree", (_event, ctx) => {
		// Leaf moved via branching or tree navigation: re-derive the goal from
		// the new branch ancestry so in-memory state tracks the session.
		restoreGoal(ctx);
		sessionCtx = ctx;
		lastReminderAt = 0;
	});

	pi.on("session_shutdown", () => {
		stopWatchdog();
		inFlightTools.clear();
	});

	// Track liveness so the watchdog can detect a stuck/idle agent (the
	// post-compaction stuck state fires no agent_end we can nudge on).
	pi.on("message_update", () => touchActivity());
	pi.on("turn_end", () => touchActivity());
	pi.on("input", () => touchActivity());
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
			await persistGoal(ctx);
			touchActivity();
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

		const messages = (event as AgentEndEvent).messages;
		const last = messages[messages.length - 1];
		if (!last || last.role !== "assistant") return;

		// If the turn ended for a reason that already has a continuation path,
		// do not add our own reminder. error/length/toolUse/aborted are handled
		// by pi-retry, max-tokens continuation, the tool loop, or the user.
		const stopReason = (last as any).stopReason;
		if (stopReason && stopReason !== "stop") return;

		// If the assistant already invoked a goal tool, tool_execution_end will handle it.
		const anyGoalTool = (last as any).toolCalls?.some(
			(tc: any) =>
				tc.name === GOAL_COMPLETE_TOOL || tc.name === GOAL_IMPOSSIBLE_TOOL,
		);
		if (anyGoalTool) return;

		// Don't spam reminders.
		const now = Date.now();
		if (now - lastReminderAt < MIN_REMINDER_INTERVAL_MS) return;
		lastReminderAt = now;

		// Don't re-nudge if the assistant already verbalized completion or impossibility.
		const text = (last as any).content
			?.map((c: any) => (typeof c === "string" ? c : (c.text ?? "")))
			.join(" ");
		if (
			text &&
			/goal complete|goal impossible|cannot (continue|proceed)|blocked/i.test(
				text,
			)
		) {
			return;
		}

		// Queue a follow-up so the agent keeps working once it becomes fully idle.
		pi.sendUserMessage(`Continue working toward the goal: ${activeGoal.goal}`, {
			deliverAs: "followUp",
		});
	});
}
