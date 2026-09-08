/**
 * pi-jtodo (@matthewfl/pi-jtodo) — a pi extension porting jcode's
 * todo quality gates.
 *
 * A real "hill climbing" todo tool: tours through small, observable work
 * items, and keeps the agent honest with
 *   - a write-time ownership gate (the only blocking write check),
 *   - deferred, budgeted turn-end quality gates (digest, completion
 *     confidence, confidence spike), and
 *   - an auto-poke cycle that continues the agent until the list settles.
 *
 * Ported with high fidelity from jcode; see the README for the fidelity
 * line, deviations, and the todo-tool lineage (Claude Code → opencode →
 * jcode → pi-jtodo).
 *
 * Files:
 *   constants.ts  — thresholds + model-visible texts (verbatim from jcode)
 *   config.ts     — optional user config
 *   model.ts      — data model + sanitizers
 *   schema.ts     — tool parameter schema (verbatim calibration text)
 *   normalize.ts  — lenient input normalization (prepareArguments)
 *   gates.ts      — pure gate logic (direct jcode ports)
 *   viewer.ts     — /todos TUI component
 *   index.ts      — state, tool execute, turn-end machine, wiring (this file)
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	CYCLE_CUSTOM_TYPE,
	ESCAPE_ABORT_WINDOW_MS,
	FOLLOWUP_CUSTOM_TYPE,
	NOTICE_COMPLETION_CHALLENGED,
	NOTICE_DIGEST_QUEUED,
	NOTICE_GATE_STALLED,
	NOTICE_GATE_UNCHANGED,
	NOTICE_POKE_OFF_HINT,
	NOTICE_SPIKE_CHALLENGED,
	QUALITY_GATE_THRESHOLD,
	TODO_CONFIDENCE_SPIKE_CONTINUATION_MESSAGE,
	TODO_TOOL_NAME,
} from "./constants.js";
import { loadConfig } from "./config.js";
import {
	buildAutoPokeMessage,
	completionConfidenceSignature,
	deriveBranchRuntime,
	freshCycleFlags,
	type BranchEvent,
	buildGateDigest,
	buildItem,
	diffItemChanges,
	formatItemChanges,
	formatCompletionLabel,
	goalChanges,
	mergeConfidenceHistory,
	inheritItemFields,
	mergeGoals,
	mergePlan,
	buildCompletionContinuationMessage,
	buildOwnershipContinuationMessage,
	buildSpikeContinuationMessage,
	findOwnershipIssues,
	planChange,
	recordReframeObservations,
	spikeCompletedTodos,
	todoConfidenceSummary,
	todosEqual,
	type CycleFlags,
} from "./gates.js";
import {
	defaultState,
	goalGroupKey,
	planIsDefault,
	sanitizeState,
	type GateObservation,
	type TodoDetails,
	type TodoGoal,
	type TodoGoalChange,
	type TodoItem,
	type TodoPlan,
	type TodoPlanChange,
	type TodoState,
} from "./model.js";
import { normalizeTodoInput } from "./normalize.js";
import { TodoParams, type TodoParamsInput } from "./schema.js";
import { TodoListComponent } from "./viewer.js";
import { TODO_WIDGET_ID, makeTodoWidget } from "./widget.js";
import { createWatchdog } from "./watchdog.js";

// ============================================================================
// Tool output (jcode build_todo_output: full stored-state echo + diffs)
// ============================================================================

function buildTodoOutput(
	todos: TodoItem[],
	plan: TodoPlan,
	goals: TodoGoal[],
	planChangeValue: TodoPlanChange | undefined,
	goalChangesValue: TodoGoalChange[] | undefined,
	changesDigest: string | undefined,
	continuations: string[],
	operation: "read" | "write" | "rejected",
): { content: { type: "text"; text: string }[]; details: TodoDetails } {
	let text = JSON.stringify(todos, null, 2);
	if (!planIsDefault(plan)) {
		text += `\n\nPlan:\n${JSON.stringify(plan, null, 2)}`;
	}
	if (goals.length > 0) {
		text += `\n\nGoals:\n${JSON.stringify(goals, null, 2)}`;
	}
	if (planChangeValue) {
		text += `\n\nPlan updates:\n${JSON.stringify(planChangeValue, null, 2)}`;
	}
	if (goalChangesValue && goalChangesValue.length > 0) {
		text += `\n\nGoal updates:\n${JSON.stringify(goalChangesValue, null, 2)}`;
	}
	if (changesDigest) {
		text += `\n\nChanges: ${changesDigest}`;
	}
	for (const continuation of continuations) {
		text += `\n\n${continuation}`;
	}
	const details: TodoDetails = { operation, todos, plan, goals };
	if (planChangeValue) details.plan_update = planChangeValue;
	if (goalChangesValue && goalChangesValue.length > 0) details.goal_updates = goalChangesValue;
	if (changesDigest) details.item_changes = changesDigest;
	return { content: [{ type: "text", text }], details };
}

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
	const config = loadConfig();

	// --- Session-scoped state (the extension instance is rebound per session)
	let state = defaultState();
	let stateLoadedForSession: string | undefined;

	// --- Turn-scoped quality observations (jcode's gate-observations log)
	const pendingObservations: GateObservation[] = [];

	// --- Auto-poke cycle (jcode App fields)
	let autoPokeArmed = config.autoPoke;
	// pi-specific: once the user has explicitly silenced the poke (poke off,
	// or Esc-interrupting a run), new open work must NOT re-arm it.
	let pokeExplicitlyOff = false;
	// Whether the most recent completed agent run was Esc-aborted, recorded
	// from the agent_end event itself (the run's own messages). Entry-scanning
	// heuristics misclassify aborts when a queued user message (compaction
	// resume, steer) lands after the aborted assistant message; an
	// Esc-aborted run must never restart the agent via a poke.
	let lastRunAborted = false;
	// Goal-plugin-style Escape correlation (pi-simple-goal): a raw Escape
	// keypress observed via terminal input marks the NEXT aborted run as the
	// user's stop. Aborts with no recent Escape behind them are machinery
	// (compaction, ctx.abort(), transport) and keep the poke cycle armed.
	let lastEscapeAt = 0;
	// Set when an Escape-classified abort pauses the poke. NOT sticky: the
	// next agent run (user re-engaged, or machinery resumed) lifts it and
	// re-arms, per the user's "stop the poke for the next while" rule.
	let escPokePaused = false;
	let unsubscribeTerminalInput: (() => void) | undefined;
	// Whether poking is allowed at all. session_start (when emitted — the
	// SDK harness and some embedders never emit it) re-derives this from
	// its ctx.hasUI; elsewhere starts optimistic, matching the module-level
	// autoPokeArmed default so embedders without lifecycle events still
	// behave like an interactive session.
	let pokeUiAllowed = true;
	let cycle: CycleFlags = freshCycleFlags();
	let settledWithoutProgress = 0;
	let lastSettledSignature: string | undefined;
	let lastChallengedSignature: string | undefined;
	let lastPokeTargets: Set<string> | undefined;
	let idleNudgeSent = false;

	function disarm() {
		autoPokeArmed = false;
		lastPokeTargets = undefined;
		cycle = freshCycleFlags();
		settledWithoutProgress = 0;
		lastSettledSignature = undefined;
		emitCycleMarker(false);
	}

	/**
	 * Persist a cycle transition so the branch walker knows where the gate
	 * flags reset (disarm here, fresh arm elsewhere). Without these entries
	 * transcript flags would be monotone across every cycle of the session:
	 * a /reload or /tree jump in cycle 2 would inherit cycle 1's
	 * digestDelivered/spikeChallenged and suppress cycle 2's gates.
	 */
	function emitCycleMarker(armed: boolean) {
		try {
			pi.appendEntry(CYCLE_CUSTOM_TYPE, { armed });
		} catch {
			// reconstruction-only; never let it break the gate flow
		}
	}

	// ------------------------------------------------------------------------
	// Delivery helpers
	// ------------------------------------------------------------------------

	function notify(
		ctx: { hasUI: boolean; ui: { notify: (m: string, k?: string) => void } },
		message: string,
	) {
		try {
			if (ctx.hasUI) ctx.ui.notify(message, "info");
		} catch {
			// display-only; never let a notice break gate logic
		}
	}

	/**
	 * Synthetic gate follow-up. Delivered as a custom session message:
	 * convertToLlm maps it to an exact role:"user" message for the model
	 * (parity with jcode's user-role continuations), while the transcript
	 * keeps customType attribution instead of a fake user bubble.
	 */
	async function sendGateFollowUp(content: string) {
		await pi.sendMessage(
			{ customType: FOLLOWUP_CUSTOM_TYPE, content, display: true },
			{ deliverAs: "followUp", triggerTurn: true },
		);
		watchdog.notifyActivity(); // dispatched follow-up restarts the starve window
	}

	interface SetWidgetUI {
		setWidget: (key: string, content?: unknown) => void;
	}

	/**
	 * Keep the above-editor widget in sync with branch state. The widget
	 * component reads state through thunks at render time, so re-setting it
	 * here only needs to happen when content may actually have changed.
	 */
	function refreshWidget(ctx: { hasUI: boolean; ui: SetWidgetUI }): void {
		if (!ctx.hasUI) return;
		try {
			if (!config.enabled || state.todos.length === 0) {
				ctx.ui.setWidget(TODO_WIDGET_ID, undefined);
			} else {
				ctx.ui.setWidget(
					TODO_WIDGET_ID,
					makeTodoWidget(
						() => state,
						() => ({
							armed: autoPokeArmed,
							escPaused: escPokePaused,
							gateAttempts: cycle.gateAttempts,
							gateMaxAttempts: config.completionGateMaxAttempts,
							pokeTargets: lastPokeTargets,
						}),
						config.widgetMaxLines,
					),
				);
			}
		} catch {
			// display-only; never let the widget break gate logic
		}
	}

	// ------------------------------------------------------------------------
	// Branch-aware state (replaces jcode's per-session JSON files)
	// ------------------------------------------------------------------------

	/**
	 * Replay every todo tool result that lies on the ancestry path of the
	 * current leaf. Compaction-safe: the session file retains compacted
	 * entries; fork/tree-safe: only ancestors of the current leaf replay.
	 */
	function reconstructState(ctx: ExtensionContext): void {
		state = defaultState();
		const entries = ctx.sessionManager.getEntries();
		const byId = new Map(entries.map((e) => [e.id, e]));
		const ancestorIds = new Set<string>();
		let id: string | null = ctx.sessionManager.getLeafId();
		while (id) {
			ancestorIds.add(id);
			const entry = byId.get(id);
			id = (entry as { parentId?: string | null } | undefined)?.parentId ?? null;
		}
		const events: BranchEvent[] = [];
		for (const entry of entries) {
			if (!ancestorIds.has(entry.id)) continue;
			if (entry.type === "message") {
				const message = (
					entry as { message?: { role?: string; toolName?: string; details?: unknown } }
				).message;
				if (message?.role !== "toolResult" || message.toolName !== TODO_TOOL_NAME) continue;
				const snapshot = sanitizeState(message.details);
				if (!snapshot) continue;
				state = snapshot;
				events.push({
					kind: "snapshot",
					openAny: snapshot.todos.some(
						(t) => t.status !== "completed" && t.status !== "cancelled",
					),
					intentHistory: snapshot.plan?.understands_user_intent_history ?? [],
					goals: snapshot.goals.map((g) => ({
						key: goalGroupKey(g.group),
						loopHistory: g.closed_feedback_loop_history ?? [],
					})),
					confidenceSignature: completionConfidenceSignature(snapshot.todos),
				});
				continue;
			}
			if (entry.type === "custom_message") {
				const cm = entry as { customType?: string; content?: unknown };
				if (cm.customType === FOLLOWUP_CUSTOM_TYPE && typeof cm.content === "string") {
					events.push({ kind: "followup", content: cm.content });
				}
			}
			if (entry.type === "custom") {
				const ce = entry as { customType?: string; data?: { armed?: unknown } };
				if (ce.customType === CYCLE_CUSTOM_TYPE) {
					events.push({ kind: "cycle", armed: ce.data?.armed === true });
				}
			}
		}
		// The gate transcript is in the log too: rebuild the cycle flags and
		// pending observations so a /reload or /tree jump does not re-litigate
		// an already-answered gate (spike evidence persists in histories; the
		// challenge transcript persists as follow-up entries on the branch).
		const runtime = deriveBranchRuntime(events);
		cycle = runtime.flags;
		lastChallengedSignature = runtime.lastChallengedSignature;
		pendingObservations.length = 0;
		pendingObservations.push(...runtime.observations);
		stateLoadedForSession = ctx.sessionManager.getSessionId();
	}

	function ensureStateLoaded(ctx: ExtensionContext): void {
		if (stateLoadedForSession !== ctx.sessionManager.getSessionId()) {
			reconstructState(ctx);
			refreshWidget(ctx);
		}
	}

	// ------------------------------------------------------------------------
	// Tool execution (jcode-app-core TodoTool::execute)
	// ------------------------------------------------------------------------

	async function execute(params: TodoParamsInput, ctx: ExtensionContext) {
		ensureStateLoaded(ctx);
		const isWrite =
			params.todos !== undefined || params.plan !== undefined || params.goals !== undefined;
		if (!isWrite) {
			return buildTodoOutput(state.todos, state.plan, state.goals, undefined, undefined, undefined, [], "read");
		}

		const previous = structuredClone(state);

		// Goals/plan-only writes keep the stored todo list; `todos` replaces it.
		if (params.todos) inheritItemFields(previous.todos, params.todos);
		const todos = params.todos ? params.todos.map(buildItem) : structuredClone(state.todos);
		mergeConfidenceHistory(previous.todos, todos);
		const goals = mergeGoals(state.goals, params.goals);
		const plan = mergePlan(state.plan, params.plan);

		// Ownership gate: the one write-blocking check. The stored list is
		// returned unchanged, so the gate cannot be routed around.
		const ownershipIssues = findOwnershipIssues(previous.todos, todos, goals);
		if (ownershipIssues.length > 0) {
			const submittedKeys = new Set((params.goals ?? []).map((g) => goalGroupKey(g.group)));
			const omittedGoals = ownershipIssues.some((i) => !submittedKeys.has(i.key));
			return buildTodoOutput(
				previous.todos,
				previous.plan,
				previous.goals,
				undefined,
				undefined,
				undefined,
				[buildOwnershipContinuationMessage(ownershipIssues, omittedGoals)],
				"rejected",
			);
		}

		const { observations, immediates } = recordReframeObservations(plan, goals, todos, previous.todos);
		appendGateObservations(observations);

		state = { todos, plan, goals };
		// pi deviation from jcode (jcode re-arms ONLY via the /poke hotkey):
		// a write that opens NEW work re-arms the poke cycle — pi has no
		// hotkey, and a fresh todo batch going unpoked after a finished cycle
		// reads as "the agent just stopped" (live dogfood fail, v1). An
		// explicit off (poke off / Esc) sticks until the user re-arms.
			const nowOpen = todos.some((t) => t.status !== "completed" && t.status !== "cancelled");
		if (nowOpen && !autoPokeArmed && !pokeExplicitlyOff && pokeUiAllowed && config.enabled) {
			autoPokeArmed = true;
			emitCycleMarker(true);
			cycle = freshCycleFlags();
			settledWithoutProgress = 0;
			lastSettledSignature = undefined;
			lastChallengedSignature = undefined;
			lastPokeTargets = undefined;
		}
		refreshWidget(ctx);

		// Assessment-only writes render the fields that changed instead of
		// repeating an otherwise identical todo plan.
		const assessmentOnly = todosEqual(todos, previous.todos);
		const planChangeValue = assessmentOnly ? planChange(previous.plan, plan) : undefined;
		const goalChangesValue =
			assessmentOnly && previous.goals.length > 0
				? goalChanges(previous.goals, goals)
				: undefined;

		// Change digest on accepted writes: what actually shifted in the
		// stored list (post-merge), so accidental drops/clears surface in
		// the write's own result instead of being discovered turns later.
		const changesDigest = params.todos
			? formatItemChanges(diffItemChanges(previous.todos, todos))
			: undefined;

		return buildTodoOutput(
			todos,
			plan,
			goals,
			planChangeValue,
			goalChangesValue,
			changesDigest,
			immediates,
			"write",
		);
	}

	function appendGateObservations(observations: GateObservation[]): void {
		if (observations.length === 0) return;
		pendingObservations.push(...observations);
		if (pendingObservations.length > config.maxGateObservations) {
			pendingObservations.splice(0, pendingObservations.length - config.maxGateObservations);
		}
	}

	// ------------------------------------------------------------------------
	// Turn-end state machine (jcode-tui input.rs::schedule_auto_poke_followup)
	// ------------------------------------------------------------------------

	function incompleteTodos(): TodoItem[] {
		return state.todos.filter((t) => t.status !== "completed" && t.status !== "cancelled");
	}

	/** True when the last assistant message on this branch was aborted (Esc). */
	function wasLastRunAborted(): boolean {
		return lastRunAborted;
	}

	// Some provider stacks (pi-robust-provider observed live: errorMessage
	// "This operation was aborted") finalize an Esc-aborted request as a
	// generic error whose text still names the abort. Those are user
	// interrupts, not provider failures, and must never restart the agent.
	function looksInterrupted(stopReason: string | undefined, errorMessage: string | undefined): boolean {
		return stopReason === "error" && typeof errorMessage === "string" && /abort/i.test(errorMessage);
	}

	function countAssistantTurnsSinceUser(ctx: ExtensionContext): number {
		const entries = ctx.sessionManager.getEntries();
		let count = 0;
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type !== "message") continue;
			const message = (entry as { message?: { role?: string } }).message;
			if (message?.role === "user") break;
			if (message?.role === "assistant") count++;
		}
		return count;
	}

	/**
	 * jcode's per-settle ordering: poke open todos first; only once the list
	 * is fully settled, deliver the deferred digest (once), then the
	 * completion-confidence and spike gates (budgeted), then disarm with a
	 * done notice.
	 */
	async function runTurnEndCheck(ctx: ExtensionContext): Promise<void> {
		const todos = state.todos;
		if (todos.length === 0) {
			// jcode: a settle with no todos at all silently disarms the poke.
			autoPokeArmed = false;
			await maybeIdleNudge(ctx);
			return;
		}

		const incomplete = incompleteTodos();
		if (incomplete.length > 0) {
			cycle.gateAttempts = 0;
			if (config.maxConsecutivePokesWithoutProgress > 0) {
				const signature = JSON.stringify(
					todos.map((t) => [t.id, t.status, t.completion_confidence]),
				);
				settledWithoutProgress =
					signature === lastSettledSignature ? settledWithoutProgress + 1 : 0;
				lastSettledSignature = signature;
				if (settledWithoutProgress >= config.maxConsecutivePokesWithoutProgress) {
					notify(
						ctx,
						"🛑 Auto-poke made no progress for several turns; stopped poking. /todos poke on to resume.",
					);
					disarm();
					return;
				}
			}
			notify(
				ctx,
				`👉 ${incomplete.length} incomplete todo${incomplete.length === 1 ? "" : "s"}. We poked it for you. ${NOTICE_POKE_OFF_HINT}`,
			);
			lastPokeTargets = new Set(incomplete.map((t) => t.id));
			await sendGateFollowUp(buildAutoPokeMessage(incomplete.length));
			return;
		}

		// All todos settled. Deferred quality digest first, once per cycle.
		if (!cycle.digestDelivered && pendingObservations.length > 0) {
			const digest = buildGateDigest(pendingObservations, state.plan, state.goals);
			pendingObservations.length = 0;
			if (digest) {
				cycle.digestDelivered = true;
				notify(ctx, NOTICE_DIGEST_QUEUED);
				await sendGateFollowUp(digest);
				return;
			}
		}

		const summary = todoConfidenceSummary(todos);
		const needsSpikeChallenge = summary.spike_detected && !cycle.spikeChallenged;
		if (summary.needs_validation || needsSpikeChallenge) {
			// Dead-lock detection: the gate outcome is a pure function of the
			// settled todos' completion confidences. If a challenged turn moved
			// no scores, the next identical prompt would produce the identical
			// resubmission — stop early instead of burning the remaining
			// attempts on a loop the user can only watch.
			const signature = completionConfidenceSignature(todos);
			const unchanged = summary.needs_validation && lastChallengedSignature === signature;
			if (!unchanged && cycle.gateAttempts < config.completionGateMaxAttempts) {
				cycle.gateAttempts += 1;
				lastChallengedSignature = signature;
				let message: string;
				if (summary.needs_validation) {
					notify(ctx, NOTICE_COMPLETION_CHALLENGED);
					// The flagged-ids list doubles as the 👉 fingers and the names in
					// the challenge message, so the agent hears exactly which items
					// the gate is judging instead of re-deriving it.
					const flaggedIds = todos
						.filter(
							(t) =>
								t.status === "completed" &&
								(t.completion_confidence === undefined ||
									t.completion_confidence < QUALITY_GATE_THRESHOLD),
						)
						.map((t) => t.id);
					lastPokeTargets = new Set(flaggedIds);
					message = buildCompletionContinuationMessage(flaggedIds);
				} else {
					cycle.spikeChallenged = true;
					notify(ctx, NOTICE_SPIKE_CHALLENGED);
					const spikedIds = spikeCompletedTodos(todos).map((t) => t.id);
					lastPokeTargets = new Set(spikedIds);
					message = buildSpikeContinuationMessage(spikedIds);
				}
				await sendGateFollowUp(message);
				return;
			}
			// Out of new information or out of budget: stop the cycle.
			notify(ctx, unchanged ? NOTICE_GATE_UNCHANGED : NOTICE_GATE_STALLED);
			lastChallengedSignature = undefined;
			disarm();
			return;
		}

		lastChallengedSignature = undefined;
		notify(ctx, `✅ All todos done. Completion confidence: ${formatCompletionLabel(summary)}.`);
		disarm();
	}

	async function maybeIdleNudge(ctx: ExtensionContext): Promise<void> {
		if (!config.idleNudge || idleNudgeSent) return;
		if (state.todos.length > 0) return;
		if (countAssistantTurnsSinceUser(ctx) < config.idleNudgeAfterAssistantTurns) return;
		idleNudgeSent = true;
		await sendGateFollowUp(
			"You have been working for a while without a todo list. If this task has multiple steps, consider using the todo tool to track progress.",
		);
	}

	// ------------------------------------------------------------------------
	// Idle starvation watchdog (jcode's queued-followup starvation watchdog,
	// shaped like pi-simple-goal's idle watchdog)
	// ------------------------------------------------------------------------

	let watchdogCtx: ExtensionContext | undefined;
	const watchdog = createWatchdog({
		now: () => Date.now(),
		isArmed: () => autoPokeArmed,
		isIdle: () => watchdogCtx?.isIdle() ?? false,
		incompleteCount: () => incompleteTodos().length,
		wasAborted: () => lastRunAborted,
		idleMs: config.watchdogIdleMs,
		maxRePokes: config.watchdogMaxRePokes,
		onFire: () => {
			if (watchdogCtx) {
				notify(
					watchdogCtx,
					"🐕 Todo watchdog: agent went quiet with open todos — poking again.",
				);
			}
			lastPokeTargets = new Set(incompleteTodos().map((t) => t.id));
			void sendGateFollowUp(buildAutoPokeMessage(incompleteTodos().length));
		},
		onStarve: (reason) => {
			disarm();
			if (watchdogCtx) {
				notify(
					watchdogCtx,
					reason === "aborted"
						? "Todo watchdog stopped (run was interrupted)."
						: "🛑 Todo watchdog: agent kept stalling with open todos; auto-poke stopped. /todos poke on to resume.",
				);
				refreshWidget(watchdogCtx);
			}
		},
	});
	const watchdogTimer = setInterval(() => {
		if (config.enabled && config.watchdog && watchdogCtx) {
			try {
				watchdog.tick();
			} catch {
				// liveness guard must never take the session down
			}
		}
	}, config.watchdogTickMs);
	(watchdogTimer as { unref?: () => void }).unref?.();

	// ------------------------------------------------------------------------
	// Tool registration
	// ------------------------------------------------------------------------

	pi.registerTool({
		name: TODO_TOOL_NAME,
		label: "Todo",
		description: "Read or update structured todo items and optional goal-level assessments.",
		promptSnippet:
			"Plan multi-step work as small todos with a plan and goal-level feedback loops.",
		promptGuidelines: [
			"Use the todo tool for any non-trivial, multi-step task: send todos, a plan, and goals on the first write.",
			"Group related todos with the todo tool's group field, one group per coherent goal, and give each goal a concrete feedback_loop.",
			"Update the todo tool as work progresses; it maintains confidence history from your updates.",
			"When completing todos with the todo tool, set completion_confidence to reflect validation you actually performed.",
		"Omit the todo tool's todos field entirely to read or keep the current list; sending an empty list clears every todo.",
			"When a group becomes fully completed in the todo tool, its goal needs an end_to_end_ownership assessment of the full user outcome.",
			"Do not stop with incomplete todos unless the user explicitly cancels the task.",
		],
		parameters: TodoParams,
		prepareArguments(args: unknown): TodoParamsInput {
			return normalizeTodoInput(args) as TodoParamsInput;
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			watchdog.notifyActivity();
			return execute(params, ctx);
		},
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("todo "));
			if (args.todos) {
				text += theme.fg("muted", `${args.todos.length} todo${args.todos.length === 1 ? "" : "s"}`);
			} else {
				text += theme.fg("muted", "read");
			}
			if (args.plan?.user_intention) {
				text += theme.fg("dim", ` "${args.plan.user_intention}"`);
			}
			if (args.goals) {
				text += theme.fg("muted", `${args.todos ? ", " : ""}${args.goals.length} goal${args.goals.length === 1 ? "" : "s"}`);
			}
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "", 0, 0);
			}
			const total = details.todos.length;
			const settled = details.todos.filter(
				(t) => t.status === "completed" || t.status === "cancelled",
			).length;
			let text =
				details.operation === "rejected"
					? theme.fg("warning", `write rejected — stored list unchanged (${settled}/${total} settled)`)
					: theme.fg("muted", `${settled}/${total} settled`);
			const display = expanded ? details.todos : details.todos.slice(0, 5);
			for (const t of display) {
				const icon =
					t.status === "completed"
						? theme.fg("success", "✓")
						: t.status === "cancelled"
							? theme.fg("error", "✗")
							: t.status === "in_progress"
								? theme.fg("accent", "▶")
								: theme.fg("dim", "○");
				const item =
					t.status === "completed" || t.status === "cancelled"
						? theme.fg("dim", t.content)
						: theme.fg("text", t.content);
				text += `\n${icon} ${theme.fg("accent", `#${t.id}`)} ${item}`;
			}
			if (!expanded && details.todos.length > 5) {
				text += `\n${theme.fg("dim", `... ${details.todos.length - 5} more`)}`;
			}
			if (expanded && details.goals.length > 0) {
				text += `\n${theme.fg("muted", "Goals:")}`;
				for (const goal of details.goals) {
					const g = goal.group ?? "(ungrouped)";
					const loop = goal.feedback_loop ? ` – ${goal.feedback_loop}` : "";
					text += `\n  ${theme.fg("accent", g)}${theme.fg("dim", loop)}`;
				}
			}
			return new Text(text, 0, 0);
		},
	});

	// ------------------------------------------------------------------------
	// /todos command
	// ------------------------------------------------------------------------

	pi.registerCommand("todos", {
		description:
			"Todo viewer and poke control (/todos, /todos export|clear|poke [on|off|status|trigger])",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			ensureStateLoaded(ctx);
			const [sub, subArg] = args.trim().split(/\s+/);
			if (sub === "export") {
				ctx.ui.notify(JSON.stringify({ ...state, pendingObservations }, null, 2), "info");
				return;
			}
			if (sub === "clear") {
				state = defaultState();
				pendingObservations.length = 0;
				lastPokeTargets = undefined;
				refreshWidget(ctx);
				ctx.ui.notify(
					"Todo list reset (session-local; history replays from branch entries).",
					"info",
				);
				return;
			}
			if (sub === "poke") {
				await handlePokeCommand(subArg, ctx);
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/todos requires TUI mode (try /todos export)", "error");
				return;
			}
			await ctx.ui.custom(
				(_tui: unknown, theme, _kb: unknown, done: (r?: unknown) => void) => {
					return new TodoListComponent(state, autoPokeArmed, theme, () => done()) as never;
				},
			);
		},
	});

	async function handlePokeCommand(arg: string | undefined, ctx: ExtensionCommandContext) {
		const action = (arg ?? "status").toLowerCase();
		if (action === "off") {
			disarm();
			pokeExplicitlyOff = true;
			refreshWidget(ctx);
			ctx.ui.notify("Auto-poke disabled.", "info");
			return;
		}
		if (action === "on" || action === "trigger") {
			autoPokeArmed = true;
			pokeExplicitlyOff = false;
			escPokePaused = false;
			cycle = freshCycleFlags();
			settledWithoutProgress = 0;
			lastChallengedSignature = undefined;
			emitCycleMarker(true);
			refreshWidget(ctx);
			ctx.ui.notify("Poke: ON", "info");
			const incomplete = incompleteTodos();
			if (incomplete.length === 0) {
				ctx.ui.notify(
					"Nothing unfinished right now; we'll poke the agent if it stops with todos left.",
					"info",
				);
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Poke queued. We'll re-check for unfinished todos after this turn.", "info");
				return;
			}
			await runTurnEndCheck(ctx);
			refreshWidget(ctx);
			return;
		}
		ctx.ui.notify(
			`Poke: ${autoPokeArmed ? "ON" : "OFF"}. ${incompleteTodos().length} incomplete todo(s).`,
			"info",
		);
	}

	// ------------------------------------------------------------------------
	// Events
	// ------------------------------------------------------------------------

	pi.on("agent_end", (event) => {
		// Record the most recent run's abort status straight from the run's
		// own messages; agent_settled reads this (it fires after agent_end).
		const messages = event.messages as Array<{ role?: string; stopReason?: string; errorMessage?: string }>;
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role === "assistant") {
				lastRunAborted = m.stopReason === "aborted" || looksInterrupted(m.stopReason, m.errorMessage);
				break;
			}
		}
		watchdog.notifyActivity();
	});

	pi.on("agent_start", (_event, ctx) => {
		// A new run means the user (or machinery) re-engaged: an Esc pause
		// lifts outside the abort-correlation window where the just-triggered
		// teardown is still settling (pi-simple-goal's maybeResumeOnActivity).
		if (escPokePaused && Date.now() - lastEscapeAt > ESCAPE_ABORT_WINDOW_MS) {
			escPokePaused = false;
			if (config.enabled && config.autoPoke && !pokeExplicitlyOff && pokeUiAllowed) {
				autoPokeArmed = true;
				cycle = freshCycleFlags();
			}
			refreshWidget(ctx);
		}
		watchdog.notifyActivity();
	});

	pi.on("session_before_compact", () => {
		watchdog.notifyActivity(); // compaction can run long; never starve the watchdog
	});
	pi.on("session_compact", () => {
		watchdog.notifyActivity();
	});
	pi.on("session_compact_failed", () => {
		watchdog.notifyActivity();
	});

	pi.on("session_start", (_event, ctx) => {
		watchdogCtx = ctx;
		watchdog.notifyActivity();
		idleNudgeSent = false;
		pendingObservations.length = 0;
		cycle = freshCycleFlags();
		lastRunAborted = false;
		settledWithoutProgress = 0;
		lastSettledSignature = undefined;
		lastChallengedSignature = undefined;
		lastPokeTargets = undefined;
		pokeExplicitlyOff = false;
		escPokePaused = false;
		lastEscapeAt = 0;
		pokeUiAllowed = ctx.hasUI;
		autoPokeArmed = config.autoPoke && ctx.hasUI;
		// TUI only: watch raw terminal input for the Escape key so an aborted
		// run can be correlated with the user's actual keypress (pi-simple-goal
		// pattern). stopReason alone is unreliable: provider stacks can
		// finalize an abort as a generic error naming the abort.
		try {
			const uictx = ctx as { mode?: string; ui: { onTerminalInput?: (cb: (data: string) => unknown) => () => void } };
			if (uictx.mode === "tui" && typeof uictx.ui.onTerminalInput === "function") {
				unsubscribeTerminalInput = uictx.ui.onTerminalInput((data) => {
					if (data === "\x1b" || data === "\x1b\x1b" || data === "\x1b[27u") {
						lastEscapeAt = Date.now();
					}
					return undefined;
				});
			}
		} catch {
			// Non-TUI or older pi: aborts fall back to machinery classification.
		}
		reconstructState(ctx);
		refreshWidget(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		// Navigation within the session: rebuild state AND the cycle flags for
		// the new branch from its own log (armed state is kept, like jcode).
		settledWithoutProgress = 0;
		lastSettledSignature = undefined;
		reconstructState(ctx);
		refreshWidget(ctx);
	});

	pi.on("input", (event) => {
		// Real user input resets the idle nudge. Our own gate follow-ups are
		// custom messages (no input event at all), but guard anyway.
		const source = (event as { source?: string }).source;
		if (source === "interactive" || source === "rpc") {
			idleNudgeSent = false;
			watchdog.notifyActivity();
		}
	});

	pi.on("agent_start", () => watchdog.notifyActivity());
	pi.on("turn_end", (_event, ctx) => {
		watchdog.notifyActivity();
		// Self-heal the strip: any repaint path pi caches against re-renders
		// at most once per turn regardless of which earlier refresh pi missed.
		refreshWidget(ctx);
	});

	pi.on("session_shutdown", () => {
		clearInterval(watchdogTimer);
		watchdogCtx = undefined;
	});

	pi.on("before_agent_start", (event) => {
		if (!config.enabled) return {};
		const reminder =
			"For non-trivial, multi-step work, plan with the todo tool before starting: small todos, grouped by goal when the task has distinct parts, with a plan stating what the user actually wants and a concrete feedback_loop for each goal. " +
			"Update the todo tool as you learn and when you complete steps; the tool's quality checks will hold you to the plan and to evidence of completion. " +
			"For simple one-off questions, skip the todo tool.";
		return { systemPrompt: (event.systemPrompt ?? "") + "\n\n" + reminder };
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!config.enabled) return;
		ensureStateLoaded(ctx);
		if (!ctx.isIdle()) return;
		// jcode's Esc: an interrupted run disarms auto-poke entirely and
		// injects no follow-up of any kind.
		if (wasLastRunAborted()) {
			// Escape correlation (pi-simple-goal pattern): only an aborted run
			// with a RECENT raw Escape keypress behind it is the user's stop —
			// that quiets the settle and pauses the poke until the next run.
			// Any other abort (compaction, ctx.abort(), transport, provider
			// stacks mislabeling the interrupt) is machinery: stay quiet and keep
			// the cycle armed; the watchdog covers a genuinely lost continuation.
			if (lastEscapeAt > 0 && Date.now() - lastEscapeAt <= ESCAPE_ABORT_WINDOW_MS) {
				disarm();
				escPokePaused = true; // not sticky: the next agent run lifts it
				refreshWidget(ctx);
				return;
			}
			return;
		}
		if (!autoPokeArmed) {
			await maybeIdleNudge(ctx);
			return;
		}
		await runTurnEndCheck(ctx);
		refreshWidget(ctx);
	});
}
