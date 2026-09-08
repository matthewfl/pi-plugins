/**
 * Data model — types ported from jcode-task-types/src/lib.rs, plus
 * sanitizers used when replaying tool-result `details` from the session
 * branch (which round-trips through JSON, so all fields are optional).
 */

export interface TodoItem {
	id: string;
	content: string;
	status: string;
	priority: string;
	group?: string;
	confidence?: number;
	completion_confidence?: number;
	/** Tool-maintained; model-supplied values are discarded on write. */
	confidence_history: number[];
}

export interface TodoPlan {
	user_intention?: string;
	understands_user_intent?: number;
	/** Tool-maintained; model-supplied values are discarded on write. */
	understands_user_intent_history: number[];
}

export interface TodoGoal {
	/** Group label this goal describes; undefined = the ungrouped flat list. */
	group?: string;
	closed_feedback_loop?: number;
	closed_feedback_loop_history: number[];
	feedback_loop?: string;
	end_to_end_ownership?: number;
	end_to_end_ownership_history: number[];
}

export type GateObservationKind = "intent_understanding" | "closed_feedback_loop";

/** A point during the turn that a quality check would have interrupted on. */
export interface GateObservation {
	kind: GateObservationKind;
	group?: string;
	score?: number;
}

export interface TodoState {
	todos: TodoItem[];
	plan: TodoPlan;
	goals: TodoGoal[];
}

export type TodoPlanField = "user_intention" | "understands_user_intent";
export interface TodoPlanChange {
	before?: TodoPlan;
	after?: TodoPlan;
	fields: TodoPlanField[];
}

export type TodoGoalField = "closed_feedback_loop" | "feedback_loop" | "end_to_end_ownership";
export interface TodoGoalChange {
	before?: TodoGoal;
	after?: TodoGoal;
	fields: TodoGoalField[];
}

export interface TodoDetails extends TodoState {
	operation: "read" | "write" | "rejected";
	/** One-line applied-change digest, set on accepted writes that changed
	 *  something: "2 updated; 1 new; removed #x; group cleared on #y". */
	item_changes?: string;
	plan_update?: TodoPlanChange;
	goal_updates?: TodoGoalChange[];
}

export function defaultState(): TodoState {
	return {
		todos: [],
		plan: { understands_user_intent_history: [] },
		goals: [],
	};
}

/** Normalized group label: trimmed, empty/whitespace -> undefined (implicit goal). */
export function goalGroupKey(group: string | undefined | null): string | undefined {
	if (group === undefined || group === null) return undefined;
	const trimmed = group.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function planIsDefault(plan: TodoPlan): boolean {
	return (
		plan.user_intention === undefined &&
		plan.understands_user_intent === undefined &&
		plan.understands_user_intent_history.length === 0
	);
}

// ----------------------------------------------------------------------------
// Sanitizers (defensive: details replayed from session JSON may be partial)
// ----------------------------------------------------------------------------

function numArray(value: unknown): number[] {
	return Array.isArray(value) ? value.filter((v): v is number => typeof v === "number") : [];
}

export function sanitizeItem(raw: unknown): TodoItem | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== "string" && typeof r.id !== "number") return undefined;
	const item: TodoItem = {
		id: String(r.id),
		content: typeof r.content === "string" ? r.content : "",
		status: typeof r.status === "string" ? r.status : "pending",
		priority: typeof r.priority === "string" ? r.priority : "medium",
		confidence_history: numArray(r.confidence_history),

	};
	if (typeof r.group === "string") item.group = r.group;
	if (typeof r.confidence === "number") item.confidence = r.confidence;
	if (typeof r.completion_confidence === "number") item.completion_confidence = r.completion_confidence;
	return item;
}

export function sanitizeState(raw: unknown): TodoState | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const r = raw as Record<string, unknown>;
	if (!Array.isArray(r.todos)) return undefined;
	const todos = r.todos.map(sanitizeItem).filter((t): t is TodoItem => t !== undefined);

	const plan: TodoPlan = { understands_user_intent_history: [] };
	if (typeof r.plan === "object" && r.plan !== null) {
		const p = r.plan as Record<string, unknown>;
		if (typeof p.user_intention === "string") plan.user_intention = p.user_intention;
		if (typeof p.understands_user_intent === "number")
			plan.understands_user_intent = p.understands_user_intent;
		plan.understands_user_intent_history = numArray(p.understands_user_intent_history);
	}

	const goals: TodoGoal[] = [];
	if (Array.isArray(r.goals)) {
		for (const g of r.goals) {
			if (typeof g !== "object" || g === null) continue;
			const gr = g as Record<string, unknown>;
			const goal: TodoGoal = {
				closed_feedback_loop_history: numArray(gr.closed_feedback_loop_history),
				end_to_end_ownership_history: numArray(gr.end_to_end_ownership_history),
			};
			if (typeof gr.group === "string") goal.group = gr.group;
			if (typeof gr.closed_feedback_loop === "number") goal.closed_feedback_loop = gr.closed_feedback_loop;
			if (typeof gr.feedback_loop === "string") goal.feedback_loop = gr.feedback_loop;
			if (typeof gr.end_to_end_ownership === "number") goal.end_to_end_ownership = gr.end_to_end_ownership;
			goals.push(goal);
		}
	}
	return { todos, plan, goals };
}
