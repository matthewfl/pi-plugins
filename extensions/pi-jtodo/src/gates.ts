/**
 * Pure gate logic — direct ports from:
 *   jcode-base/src/todo.rs       (gate predicates, digest, confidence summary)
 *   jcode-app-core/src/tool/todo.rs (merge helpers, observation recording)
 *
 * Everything in this file is free of pi APIs and side effects so the gate
 * behavior stays unit-testable and maps 1:1 to the jcode functions it ports.
 */

import {
	LOW_CLOSED_FEEDBACK_LOOP,
	LOW_INTENT_UNDERSTANDING,
	QUALITY_GATE_THRESHOLD,
	SEVERE_INTENT_MISUNDERSTANDING,
	TODO_CONFIDENCE_SPIKE,
	TODO_COMPLETION_CONTINUATION_MESSAGE,
	TODO_CONFIDENCE_SPIKE_CONTINUATION_MESSAGE,
	TODO_GATE_DIGEST_PREFIX,
	TODO_INTENT_UNDERSTANDING_CONTINUATION_MESSAGE,
	TODO_OWNERSHIP_CONTINUATION_MESSAGE,
} from "./constants.js";
import {
	goalGroupKey,
	type GateObservation,
	type GateObservationKind,
	type TodoGoal,
	type TodoGoalChange,
	type TodoGoalField,
	type TodoItem,
	type TodoPlan,
	type TodoPlanChange,
} from "./model.js";
import type { TodoGoalInput, TodoItemInput, TodoPlanInput } from "./schema.js";

// ----------------------------------------------------------------------------
// Score histories (tool-maintained; one observation per write max)
// ----------------------------------------------------------------------------

/** Append `value` when it is a new observation. */
export function recordScoreObservation(
	history: number[],
	value: number | undefined | null,
): void {
	if (value === undefined || value === null) return;
	if (history.length > 0 && history[history.length - 1] === value) return;
	history.push(value);
}

/**
 * Fold each incoming todo's confidence into its tool-maintained history.
 * The model reports `confidence` while working and `completion_confidence`
 * at completion; each write contributes at most one observation, so a single
 * completion update cannot manufacture an apparent intermediate step.
 * Model-supplied histories are ignored: the tool owns this field.
 */
export function mergeConfidenceHistory(previous: TodoItem[], incoming: TodoItem[]): void {
	const prior = new Map(previous.map((t) => [t.id, t]));
	for (const todo of incoming) {
		const prev = prior.get(todo.id);
		const history = prev ? [...prev.confidence_history] : [];
		if (history.length === 0 && prev) {
			const value =
				prev.status === "completed"
					? (prev.completion_confidence ?? prev.confidence)
					: prev.confidence;
			if (value !== undefined) history.push(value);
		}
		const observation =
			todo.status === "completed"
				? (todo.completion_confidence ?? todo.confidence)
				: todo.confidence;
		recordScoreObservation(history, observation);
		todo.confidence_history = history;
	}
}

/**
 * Merge incoming goal assessments with the stored ones: incoming wins per
 * group key, omitted fields inherit the stored assessment, unmentioned
 * stored groups are retained. Score histories are tool-maintained.
 */
export function mergeGoals(stored: TodoGoal[], incoming: TodoGoalInput[] | undefined): TodoGoal[] {
	if (!incoming) return stored.map((g) => ({ ...g }));
	const merged: TodoGoal[] = [];
	for (const goalInput of incoming) {
		const group = goalGroupKey(goalInput.group);
		const previous = stored.find((g) => goalGroupKey(g.group) === group);
		const goal: TodoGoal = {
			group,
			closed_feedback_loop: goalInput.closed_feedback_loop ?? previous?.closed_feedback_loop,
			closed_feedback_loop_history: previous ? [...previous.closed_feedback_loop_history] : [],
			feedback_loop: goalInput.feedback_loop ?? previous?.feedback_loop,
			end_to_end_ownership: goalInput.end_to_end_ownership ?? previous?.end_to_end_ownership,
			end_to_end_ownership_history: previous ? [...previous.end_to_end_ownership_history] : [],
		};
		recordScoreObservation(goal.closed_feedback_loop_history, goal.closed_feedback_loop);
		recordScoreObservation(goal.end_to_end_ownership_history, goal.end_to_end_ownership);
		const slot = merged.find((g) => goalGroupKey(g.group) === group);
		if (slot) {
			Object.assign(slot, goal);
		} else {
			merged.push(goal);
		}
	}
	for (const prev of stored) {
		const key = goalGroupKey(prev.group);
		if (!merged.some((g) => goalGroupKey(g.group) === key)) {
			merged.push({ ...prev });
		}
	}
	return merged;
}

/**
 * Merge the incoming plan-level intent assessment with the stored one. An
 * omitted intention inherits the stored value; an empty string clears it.
 * The history trail is tool-maintained.
 */
export function mergePlan(stored: TodoPlan, incoming: TodoPlanInput | undefined): TodoPlan {
	if (!incoming) {
		return {
			...stored,
			understands_user_intent_history: [...stored.understands_user_intent_history],
		};
	}
	const plan: TodoPlan = {
		user_intention:
			incoming.user_intention !== undefined ? incoming.user_intention : stored.user_intention,
		understands_user_intent: incoming.understands_user_intent ?? stored.understands_user_intent,
		understands_user_intent_history: [...stored.understands_user_intent_history],
	};
	recordScoreObservation(plan.understands_user_intent_history, plan.understands_user_intent);
	return plan;
}

// ----------------------------------------------------------------------------
// Concise assessment diffs (rendered on assessment-only writes)
// ----------------------------------------------------------------------------

export function planChange(before: TodoPlan, after: TodoPlan): TodoPlanChange | undefined {
	const fields: TodoPlanChange["fields"] = [];
	if (before.user_intention !== after.user_intention) fields.push("user_intention");
	if (before.understands_user_intent !== after.understands_user_intent)
		fields.push("understands_user_intent");
	if (fields.length === 0) return undefined;
	return { before, after, fields };
}

function changedGoalFields(
	before: TodoGoal | undefined,
	after: TodoGoal | undefined,
): TodoGoalField[] {
	const fields: TodoGoalField[] = [];
	if (before?.closed_feedback_loop !== after?.closed_feedback_loop)
		fields.push("closed_feedback_loop");
	if (before?.feedback_loop !== after?.feedback_loop) fields.push("feedback_loop");
	if (before?.end_to_end_ownership !== after?.end_to_end_ownership)
		fields.push("end_to_end_ownership");
	return fields;
}

export function goalChanges(before: TodoGoal[], after: TodoGoal[]): TodoGoalChange[] {
	const changes: TodoGoalChange[] = [];
	for (const current of after) {
		const key = goalGroupKey(current.group);
		const previous = before.find((g) => goalGroupKey(g.group) === key);
		const fields = changedGoalFields(previous, current);
		if (fields.length > 0) changes.push({ before: previous, after: current, fields });
	}
	for (const previous of before) {
		const key = goalGroupKey(previous.group);
		if (after.some((g) => goalGroupKey(g.group) === key)) continue;
		const fields = changedGoalFields(previous, undefined);
		if (fields.length > 0) changes.push({ before: previous, fields });
	}
	return changes;
}

// ----------------------------------------------------------------------------
// Group completion and the ownership gate
// ----------------------------------------------------------------------------

export function groupIsComplete(todos: TodoItem[], group: string | undefined): boolean {
	const matching = todos.filter((t) => goalGroupKey(t.group) === group);
	return matching.length > 0 && matching.every((t) => t.status === "completed");
}

/** Groups this update closes: complete in `incoming`, not complete before. */
export function groupsClosedByUpdate(
	previous: TodoItem[],
	incoming: TodoItem[],
): (string | undefined)[] {
	const groups: (string | undefined)[] = [];
	for (const todo of incoming) {
		const group = goalGroupKey(todo.group);
		if (groups.includes(group)) continue;
		if (groupIsComplete(incoming, group) && !groupIsComplete(previous, group)) {
			groups.push(group);
		}
	}
	return groups;
}

/**
 * The single write-blocking gate: every group newly closed by this update
 * (including the implicit ungrouped goal) must carry sufficient
 * end_to_end_ownership. Groups completed before this write are grandfathered.
 */
export interface OwnershipIssue {
	key: string | null;
	ownership: number | undefined;
}

/**
 * Which groups this write closes without a sufficient ownership claim.
 * The rejection message names these — a silent boolean rejection made
 * agents flail (drop goals, spam ownership=100) instead of addressing
 * the actual failing group(s).
 */
export function findOwnershipIssues(
	previous: TodoItem[],
	incoming: TodoItem[],
	goals: TodoGoal[],
): OwnershipIssue[] {
	const issues: OwnershipIssue[] = [];
	const groups: (string | null)[] = [];
	for (const todo of incoming) {
		const group = goalGroupKey(todo.group);
		if (!groups.includes(group)) groups.push(group);
	}
	for (const group of groups) {
		if (!groupIsComplete(incoming, group) || groupIsComplete(previous, group)) continue;
		const goal = goals.find((g) => goalGroupKey(g.group) === group);
		const ownership = goal?.end_to_end_ownership;
		if (ownership === undefined || ownership < QUALITY_GATE_THRESHOLD) {
			issues.push({ key: group, ownership });
		}
	}
	return issues;
}

export function newlyCompletedGroupsHaveSufficientOwnership(
	previous: TodoItem[],
	incoming: TodoItem[],
	goals: TodoGoal[],
): boolean {
	return findOwnershipIssues(previous, incoming, goals).length === 0;
}

const ownershipGroupName = (key: string | null): string =>
	key === null ? "the ungrouped todo list (the implicit goal)" : `"${key}"`;

export function buildOwnershipContinuationMessage(
	issues: OwnershipIssue[],
	omittedGoals: boolean,
): string {
	const names = issues.map((i) => ownershipGroupName(i.key)).join(", ");
	const missing = issues.filter((i) => i.ownership === undefined).length;
	let guidance =
		` Groups this write completes without an honest end_to_end_ownership claim: ${names}` +
		(missing > 0 ? " (some lack the field entirely)" : "") +
		". end_to_end_ownership is your assertion that you delivered the group's full intended " +
		"outcome: the checks actually ran and passed, the complete workflow was validated, and " +
		"no follow-through the user cares about is left outside the remaining list. If you " +
		"cannot honestly claim that for a group, leave its todos unfinished instead of raising " +
		"the number — the gate is asking for the evidence behind the claim, not a bigger number.";
	if (omittedGoals) {
		guidance +=
			" Goals omitted from the goals array are retained from the previous write; dropping a group's goal entry does not exempt it from this check.";
	}
	return TODO_OWNERSHIP_CONTINUATION_MESSAGE + guidance;
}

export function buildCompletionContinuationMessage(flaggedIds: string[]): string {
	if (flaggedIds.length === 0) return TODO_COMPLETION_CONTINUATION_MESSAGE;
	return (
		TODO_COMPLETION_CONTINUATION_MESSAGE +
		` Specifically, completion confidence is missing or not high enough on: ${flaggedIds
			.map((id) => `#${id}`)
			.join(", ")}. Re-verify those items against concrete evidence — re-run the check that proves each one — then re-send scores reflecting what you actually validated, or re-open the items you cannot verify.`
	);
}

export function buildSpikeContinuationMessage(spikedIds: string[]): string {
	if (spikedIds.length === 0) return TODO_CONFIDENCE_SPIKE_CONTINUATION_MESSAGE;
	return (
		TODO_CONFIDENCE_SPIKE_CONTINUATION_MESSAGE +
		` The sudden rise happened on: ${spikedIds
			.map((id) => `#${id}`)
			.join(", ")}. Sudden rises usually mean verification was skipped mid-work and the score is an estimate now: re-validate those items with concrete evidence and report steady scores, or score them honestly if they were estimates.`
	);
}

/**
 * Completed todos whose final confidence step was abrupt rather than
 * accumulated in evidence-backed steps. Legacy records with no history fall
 * back to comparing planning confidence with completion confidence.
 */
export function spikeCompletedTodos(todos: TodoItem[]): TodoItem[] {
	return todos.filter((todo) => {
		if (todo.status !== "completed") return false;
		const history = todo.confidence_history;
		if (history.length === 0) {
			const first = todo.confidence;
			const last = todo.completion_confidence;
			if (first === undefined || last === undefined) return false;
			return Math.max(0, last - first) >= TODO_CONFIDENCE_SPIKE;
		}
		if (history.length === 1) return false;
		const n = history.length;
		return Math.max(0, history[n - 1] - history[n - 2]) >= TODO_CONFIDENCE_SPIKE;
	});
}

// ----------------------------------------------------------------------------
// Deferred quality observations
// ----------------------------------------------------------------------------

/**
 * Record the points this write would previously have interrupted on, and
 * return the rare continuation still worth sending immediately.
 *
 * Deferred, not forgiven: understanding starts low and rises as the agent
 * explores, so interrupting on every low write mostly punishes agents that
 * are already fixing it. The one exception is a first plan write that
 * scores severely low — a whole turn of wrong work cannot be undone at
 * turn end.
 */
export function recordReframeObservations(
	plan: TodoPlan,
	goals: TodoGoal[],
	todos: TodoItem[],
	previous: TodoItem[],
): { observations: GateObservation[]; immediates: string[] } {
	const observations: GateObservation[] = [];
	const immediates: string[] = [];
	const anyOpen = todos.some((t) => t.status !== "completed" && t.status !== "cancelled");
	if (
		anyOpen &&
		(plan.understands_user_intent === undefined ||
			plan.understands_user_intent < LOW_INTENT_UNDERSTANDING)
	) {
		observations.push({ kind: "intent_understanding", score: plan.understands_user_intent });
		// Only on the first observation of the plan, so a persistently low
		// score is reported once at turn end rather than on every write.
		const firstAssessment = plan.understands_user_intent_history.length <= 1;
		if (
			firstAssessment &&
			plan.understands_user_intent !== undefined &&
			plan.understands_user_intent < SEVERE_INTENT_MISUNDERSTANDING
		) {
			immediates.push(TODO_INTENT_UNDERSTANDING_CONTINUATION_MESSAGE);
		}
	}
	const closedNow = groupsClosedByUpdate(previous, todos);
	for (const goal of goals) {
		const groupOpen = todos.some(
			(t) =>
				goalGroupKey(t.group) === goalGroupKey(goal.group) &&
				t.status !== "completed" &&
				t.status !== "cancelled",
		);
		// A group this write closes counts too: a goal created and finished in
		// one step is otherwise never observed, and one-step completions are
		// where a weak feedback loop hides best.
		if (!groupOpen && !closedNow.includes(goalGroupKey(goal.group))) continue;
		if (
			goal.closed_feedback_loop === undefined ||
			goal.closed_feedback_loop < LOW_CLOSED_FEEDBACK_LOOP
		) {
			observations.push({
				kind: "closed_feedback_loop",
				group: goalGroupKey(goal.group),
				score: goal.closed_feedback_loop,
			});
		}
	}
	return { observations, immediates };
}

/**
 * Whether the score behind this observation has since reached its bar. No
 * longer suppresses the observation — it selects the wording instead, so a
 * late climb is described as a coverage gap rather than as never closed.
 */
function observationScoreLaterCleared(
	observation: GateObservation,
	plan: TodoPlan,
	goals: TodoGoal[],
): boolean {
	if (observation.kind === "intent_understanding") {
		return (
			plan.understands_user_intent !== undefined &&
			plan.understands_user_intent >= LOW_INTENT_UNDERSTANDING
		);
	}
	const goal = goals.find((g) => goalGroupKey(g.group) === goalGroupKey(observation.group));
	return (
		goal?.closed_feedback_loop !== undefined &&
		goal.closed_feedback_loop >= LOW_CLOSED_FEEDBACK_LOOP
	);
}

/**
 * Build the turn-end reminder from the turn's recorded observations. Every
 * point is surfaced, including ones whose score later rose past the bar (a
 * late climb is exactly the case worth raising). Repeats of the same point
 * collapse into one line with a count.
 */
export function buildGateDigest(
	observations: GateObservation[],
	plan: TodoPlan,
	goals: TodoGoal[],
): string | undefined {
	if (observations.length === 0) return undefined;
	const points: { kind: GateObservationKind; group?: string; count: number; cleared: boolean }[] =
		[];
	for (const observation of observations) {
		const cleared = observationScoreLaterCleared(observation, plan, goals);
		const existing = points.find(
			(p) => p.kind === observation.kind && p.group === observation.group,
		);
		if (existing) {
			existing.count += 1;
		} else {
			points.push({ kind: observation.kind, group: observation.group, count: 1, cleared });
		}
	}
	if (points.length === 0) return undefined;
	let message = TODO_GATE_DIGEST_PREFIX;
	for (const point of points) {
		message += `\n- ${buildGateDigestDetail(point.kind, point.group, point.cleared)}`;
		if (point.count > 1) message += ` (flagged ${point.count} times this turn)`;
	}
	message +=
		"\nAddress the points above, then update the todo tool with the assessments that reflect what you verified.";
	return message;
}

function buildGateDigestDetail(
	kind: GateObservationKind,
	group: string | undefined,
	cleared: boolean,
): string {
	if (kind === "intent_understanding") {
		return cleared
			? "you started this work without understanding what the user actually wants, and only settled it later. Re-check the work you did before it settled against the request you now understand, and state any interpretation you had to guess at."
			: "your understanding of what the user actually wants never became solid. Re-read the request, confirm the work you did matches it, and state any interpretation you had to guess at.";
	}
	const label = group ? ` for "${group}"` : "";
	return cleared
		? `the goal${label} was worked on before its feedback loop was closed, so the loop you ended up with never ran over that earlier work. Run it over the whole result now and report what it actually reported back.`
		: `the goal${label} never closed its feedback loop: no observation reported back on whether the work satisfied the requirements. Confirm the result is actually better, with concrete evidence rather than inspection.`;
}

export function buildAutoPokeMessage(incompleteCount: number): string {
	return `You have ${incompleteCount} incomplete todo${incompleteCount === 1 ? "" : "s"}. Continue working, or update the todo tool.`;
}

const AUTO_POKE_SUFFIX = "Continue working, or update the todo tool.";

/**
 * Identity of the completion-gate inputs: which todos are settled and with
 * what completion confidence. Challenging the same signature twice cannot
 * produce a different outcome, so a re-validation pass that moves no scores
 * should stop the gate early instead of burning the remaining attempts
 * (pi-specific; jcode relies on its challenged agents actually moving).
 */
export function completionConfidenceSignature(todos: TodoItem[]): string {
	return todos
		.filter((t) => t.status === "completed" || t.status === "cancelled")
		.map((t) => `${t.id}:${t.status}:${t.completion_confidence ?? "-"}`)
		.sort()
		.join("|");
}

// ----------------------------------------------------------------------------
// Branch runtime (cycle flags + pending observations) derived from the log
// ----------------------------------------------------------------------------

export interface CycleFlags {
	digestDelivered: boolean;
	spikeChallenged: boolean;
	gateAttempts: number;
}

export function freshCycleFlags(): CycleFlags {
	return { digestDelivered: false, spikeChallenged: false, gateAttempts: 0 };
}

/** A stored todo snapshot as one event in the branch walk. */
export interface BranchSnapshotEvent {
	kind: "snapshot";
	openAny: boolean;
	intentHistory: number[];
	goals: { key: string | null; loopHistory: number[] }[];
	/** completionConfidenceSignature of this snapshot's todos */
	confidenceSignature: string;
}

export interface BranchFollowupEvent {
	kind: "followup";
	content: string;
}

/**
 * A persisted auto-poke cycle transition (CYCLE_CUSTOM_TYPE entry).
 * Emitted wherever the live machine resets or would reset the gate flags:
 * every disarm() and every fresh arm (write re-arm, /todos poke on).
 * The walker resets flags on every marker, matching the live machine.
 */
export interface BranchCycleEvent {
	kind: "cycle";
	armed: boolean;
}

export type BranchEvent = BranchSnapshotEvent | BranchFollowupEvent | BranchCycleEvent;

export interface BranchRuntime {
	flags: CycleFlags;
	observations: GateObservation[];
	/**
	 * The completion signature when the LAST completion-gate challenge was
	 * sent, or undefined when the signature moved since. Mirrors the
	 * in-memory deadlock detector across reloads/tree jumps: a challenge
	 * whose target scores never moved is recoverable from the branch.
	 */
	lastChallengedSignature: string | undefined;
}

/**
 * Rebuild the turn-end machine's ephemera from the branch log so /reload
 * and /tree jumps restore exactly what this branch already experienced.
 *
 * Cycle flags: digestDelivered and spikeChallenged stick once their
 * message was sent; gateAttempts counts completion/spike messages since
 * the last auto-poke (the in-session machine resets attempts on every
 * incomplete settle, and every armed incomplete settle emits one poke).
 *
 * Pending observations: a DELTA walk, not a history scan. Score histories
 * are cumulative across cycles and undated, so "any sub-threshold entry"
 * would re-derive observations a long-delivered digest already consumed.
 * Instead, each snapshot's entries beyond the previous snapshot's history
 * length are the scores that specific write appended — the same stream
 * recordReframeObservations saw live — and a digest follow-up clears the
 * accumulator, mirroring the in-session clear-on-delivery. Two lossy
 * corners, both quiet-er direction: re-sent scores that appended nothing
 * can't be counted (digest "flagged N times" may under-count), and the
 * in-session "group open / closed by this write" filter is dropped for
 * reconstructed loop observations (extra review, never less).
 */
export function deriveBranchRuntime(events: BranchEvent[]): BranchRuntime {
	const flags = freshCycleFlags();
	const observations: GateObservation[] = [];
	let completionSincePoke = 0;
	let spikeSincePoke = 0;
	let prevIntentLen = 0;
	const prevLoopLen = new Map<string | null, number>();
	let latestSignature: string | undefined;
	let signatureAtLastChallenge: string | undefined;
	for (const ev of events) {
		if (ev.kind === "snapshot") {
			latestSignature = ev.confidenceSignature;
			for (const score of ev.intentHistory.slice(prevIntentLen)) {
				if (ev.openAny && score < LOW_INTENT_UNDERSTANDING) {
					observations.push({ kind: "intent_understanding", score });
				}
			}
			prevIntentLen = ev.intentHistory.length;
			for (const goal of ev.goals) {
				const fresh = goal.loopHistory.slice(prevLoopLen.get(goal.key) ?? 0);
				for (const score of fresh) {
					if (score < LOW_CLOSED_FEEDBACK_LOOP) {
						observations.push({
							kind: "closed_feedback_loop",
							group: goal.key ?? undefined,
							score,
						});
					}
				}
				prevLoopLen.set(goal.key, goal.loopHistory.length);
			}
			continue;
		}
		if (ev.kind === "cycle") {
			flags.digestDelivered = false;
			flags.spikeChallenged = false;
			completionSincePoke = 0;
			spikeSincePoke = 0;
			signatureAtLastChallenge = undefined;
			// NOTE: pending observations are kept across cycle boundaries on
			// purpose (jcode clears them only when a digest is delivered).
			continue;
		}
		const content = ev.content;
		if (content.startsWith(TODO_GATE_DIGEST_PREFIX)) {
			flags.digestDelivered = true;
			observations.length = 0; // delivery consumed the observations, as in-session
		} else if (content.startsWith(TODO_COMPLETION_CONTINUATION_MESSAGE)) {
			completionSincePoke += 1;
			signatureAtLastChallenge = latestSignature;
		} else if (content.startsWith(TODO_CONFIDENCE_SPIKE_CONTINUATION_MESSAGE)) {
			flags.spikeChallenged = true;
			spikeSincePoke += 1; // spike-only message consumes a completion-gate attempt (jcode shares the budget)
		} else if (content.endsWith(AUTO_POKE_SUFFIX)) {
			completionSincePoke = 0;
			spikeSincePoke = 0;
		}
	}
	flags.gateAttempts = completionSincePoke + spikeSincePoke;
	return {
		flags,
		observations,
		lastChallengedSignature:
			signatureAtLastChallenge !== undefined && signatureAtLastChallenge === latestSignature
				? signatureAtLastChallenge
				: undefined,
	};
}

// ----------------------------------------------------------------------------
// Completion-confidence summary (jcode-tui commands.rs::todo_confidence_summary)
// ----------------------------------------------------------------------------

export interface TodoConfidenceSummary {
	completion_average: number | undefined;
	needs_validation: boolean;
	spike_detected: boolean;
}

function todoConfidenceWeight(priority: string): number {
	if (priority === "high") return 3;
	if (priority === "medium") return 2;
	return 1;
}

/** Rounded weighted average (round-half-up), or undefined when empty. */
function weightedConfidenceAverage(scores: Iterable<[score: number, weight: number]>): number | undefined {
	let weightedSum = 0;
	let totalWeight = 0;
	for (const [score, weight] of scores) {
		weightedSum += score * weight;
		totalWeight += weight;
	}
	if (totalWeight === 0) return undefined;
	return Math.floor((weightedSum + Math.floor(totalWeight / 2)) / totalWeight);
}

export function todoConfidenceSummary(todos: TodoItem[]): TodoConfidenceSummary {
	const completed = todos.filter((t) => t.status === "completed");
	const scored: [number, number][] = [];
	let missing = 0;
	let below = 0;
	for (const todo of completed) {
		if (todo.completion_confidence === undefined) {
			missing += 1;
			continue;
		}
		scored.push([todo.completion_confidence, todoConfidenceWeight(todo.priority)]);
		if (todo.completion_confidence < QUALITY_GATE_THRESHOLD) below += 1;
	}
	const average = weightedConfidenceAverage(scored);
	const needsValidation =
		average === undefined || average < QUALITY_GATE_THRESHOLD || missing > 0 || below > 0;
	return {
		completion_average: average,
		needs_validation: needsValidation,
		spike_detected: spikeCompletedTodos(todos).length > 0,
	};
}

export function formatCompletionLabel(summary: TodoConfidenceSummary): string {
	return summary.completion_average === undefined ? "unknown" : `${summary.completion_average}%`;
}

// ----------------------------------------------------------------------------
// Small shared helpers
// ----------------------------------------------------------------------------

export function todosEqual(a: TodoItem[], b: TodoItem[]): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Build a stored TodoItem from validated input (whitelisted fields only). */
/** Field-level inheritance for update-style writes (pi deviation from jcode's
 *  whole-item replace): when an existing id is re-sent with an optional field
 *  omitted, the stored value is inherited instead of silently dropped. The one
 *  explicit clear is `group: ""` (a blank label lands the item in the
 *  ungrouped bucket). Membership semantics are unchanged: omitting an ITEM
 *  deletes it; omitting a FIELD inherits it. Mutates the inputs in place. */
/** Post-apply diff of the model-controlled item fields (confidence_history is
 *  tool-owned and deliberately ignored — otherwise every touched item would
 *  count as "changed"). Drives the "Changes: …" digest appended to accepted
 *  writes so the agent notices unintended effects (a dropped item, a cleared
 *  group) immediately, instead of discovering them turns later. */
export interface ItemChanges {
	added: string[];
	removed: string[];
	updated: string[];
	groupCleared: string[];
}

export function diffItemChanges(previous: TodoItem[], next: TodoItem[]): ItemChanges {
	const prevById = new Map(previous.map((t) => [t.id, t]));
	const nextById = new Map(next.map((t) => [t.id, t]));
	const out: ItemChanges = { added: [], removed: [], updated: [], groupCleared: [] };
	for (const t of next) {
		const p = prevById.get(t.id);
		if (!p) {
			out.added.push(t.id);
			continue;
		}
		if (
			t.content !== p.content ||
			t.status !== p.status ||
			t.priority !== p.priority ||
			t.group !== p.group ||
			t.confidence !== p.confidence ||
			t.completion_confidence !== p.completion_confidence
		) {
			// Group clears get named separately from generic updates: the move
			// re-buckets the item's goal, which is the dangerous silent case.
			if (p.group !== undefined && t.group === undefined) out.groupCleared.push(t.id);
			else out.updated.push(t.id);
		}
	}
	for (const p of previous) if (!nextById.has(p.id)) out.removed.push(p.id);
	return out;
}

/** One-line digest for the tool result text; undefined when nothing changed
 *  (quiet is golden — a no-op resend prints no Changes line). Removals and
 *  group clears are always named; updates/additions stay counts. */
export function formatItemChanges(c: ItemChanges): string | undefined {
	const parts: string[] = [];
	if (c.updated.length) parts.push(`${c.updated.length} updated`);
	if (c.added.length) parts.push(`${c.added.length} new`);
	if (c.removed.length) parts.push(`removed ${c.removed.map((id) => `#${id}`).join(", ")}`);
	if (c.groupCleared.length)
		parts.push(`group cleared on ${c.groupCleared.map((id) => `#${id}`).join(", ")}`);
	return parts.length ? parts.join("; ") : undefined;
}

export function inheritItemFields(previous: TodoItem[], inputs: TodoItemInput[]): void {
	const prior = new Map(previous.map((t) => [t.id, t]));
	for (const input of inputs) {
		const prev = prior.get(input.id);
		if (!prev) continue;
		if (input.group === undefined && prev.group !== undefined) input.group = prev.group;
		if (input.completion_confidence === undefined && prev.completion_confidence !== undefined)
			input.completion_confidence = prev.completion_confidence;
	}
}

export function buildItem(input: TodoItemInput): TodoItem {
	const item: TodoItem = {
		id: input.id,
		content: input.content,
		status: input.status,
		priority: input.priority,
		confidence: input.confidence,
		confidence_history: [],
	};
	// group: "" is the explicit clear (blank label → ungrouped); with
	// inheritItemFields running earlier, undefined here means a genuinely
	// new ungrouped item, not an omission.
	if (input.group !== undefined && input.group.trim() !== "") item.group = input.group;
	if (input.completion_confidence !== undefined)
		item.completion_confidence = input.completion_confidence;
	return item;
}
