/**
 * Tool parameter schema — field names, required arrays, and description
 * texts verbatim from jcode-app-core/src/tool/todo.rs::parameters_schema().
 * The descriptions are handwritten model-visible calibration text: they
 * never mention thresholds, gate wording, scores, or domain hints.
 */

import { type Static, Type } from "typebox";

export const TodoItemSchema = Type.Object({
	content: Type.String({ description: "Task." }),
	status: Type.String({ description: "Status." }),
	priority: Type.String({ description: "Priority." }),
	id: Type.String({ description: "ID." }),
	group: Type.Optional(
		Type.String({
			description:
				"Optional group label, encouraged. Prefer a group whenever the task has more than one step: todos sharing a group render together under one header, so use one group per coherent goal (e.g. 'optimize rendering'), and start a new group instead of renaming the existing one when the user steers into new work. Omit only for a one-off flat list (ungrouped items share one implicit goal and its checks). On update-style writes, omitting this field keeps the item's existing group — send an empty string to clear it.",
		}),
	),
	confidence: Type.Integer({
		minimum: 0,
		maximum: 100,
		description:
			"Self-assessed confidence, 0-100, that this todo can be completed correctly. Reassess it as evidence accumulates while working.",
	}),
	completion_confidence: Type.Optional(
		Type.Integer({
			minimum: 0,
			maximum: 100,
			description:
				"Self-assessed confidence, 0-100, that this todo was completed correctly. Use only for completed items. On later writes, omitting this field keeps the stored value for this id.",
		}),
	),
});

export const TodoPlanInputSchema = Type.Object(
	{
		user_intention: Type.String({
			description:
				"Concise statement of what the user actually wants: their underlying reason and desired end state for this work. Omit on later updates to retain the stored intention.",
		}),
		understands_user_intent: Type.Integer({
			minimum: 0,
			maximum: 100,
			description:
				"Self-assessment, 0-100, of how well you understand what the user actually wants and how faithfully this plan represents it: their underlying goal, what they left implicit, and what outcome would make them consider this done. Before scoring, form a requirement inventory covering outcomes, deliverables, constraints, prohibited actions, integration paths, edge cases, and necessary follow-through, and check that the plan and its feedback loops name an explicit observation or check for each item. A generic instruction to run tests, verify, or review does not establish coverage: tests count only for behaviors they actually enforce, while non-testable requirements such as edit scope, dependency limits, required reporting, branches or commits, and prohibited modifications need separate explicit checks. Score low when interpretations of the request still materially diverge, you are guessing at intent, or any material item is unrepresented. Prefer resolving low understanding by re-reading the request and investigating the conversation and codebase over asking the user, since asking blocks them.",
		}),
	},
	{
		description:
			"Plan-level understanding of the user's request, covering the whole todo list. Send it on the first write and whenever your understanding changes.",
	},
);

export const TodoGoalSchema = Type.Object({
	group: Type.Optional(
		Type.String({
			description: "Group label this goal describes. Omit or null for the ungrouped list.",
		}),
	),
	closed_feedback_loop: Type.Integer({
		minimum: 0,
		maximum: 100,
		description:
			"Self-assessment, 0-100: how much of this goal's correctness the `feedback_loop` below can tell you on its own, without your judgment or the user's.",
	}),
	feedback_loop: Type.String({
		description:
			"Concrete requirement-to-check process used to compare progress across iterations and detect whether the user's intention is satisfied or violated. Name an explicit observation or check for every material behavior, deliverable, constraint, prohibited action, integration path, edge case, and necessary follow-through. Generic phrases such as run tests, verify, or review count only for requirements those named checks demonstrably enforce; add separate checks for non-testable prompt requirements.",
	}),
	end_to_end_ownership: Type.Optional(
		Type.Integer({
			minimum: 0,
			maximum: 100,
			description:
				"Completion-time self-assessment, 0-100, of whether the full intended user outcome and its necessary follow-through were delivered, rather than only the immediate implementation. Use only when completing the goal.",
		}),
	),
});

export const TodoParams = Type.Object({
	todos: Type.Optional(
		Type.Array(TodoItemSchema, {
			description:
				"Todo list to save. Replaces the stored list when present: re-list every item (omitting one deletes it), but only re-type fields you are changing — optional fields you omit on an existing id are inherited. To read or keep the current list, omit the field entirely — never send an empty array unless you intend to clear every todo.",
		}),
	),
	plan: Type.Optional(TodoPlanInputSchema),
	goals: Type.Optional(
		Type.Array(TodoGoalSchema, {
			description:
				"Optional goal-level assessments, one per todo group. Use group: null for an ungrouped list. Stored assessments for groups omitted from an update are retained.",
		}),
	),
});

export type TodoParamsInput = Static<typeof TodoParams>;
export type TodoItemInput = Static<typeof TodoItemSchema>;
export type TodoPlanInput = Static<typeof TodoPlanInputSchema>;
export type TodoGoalInput = Static<typeof TodoGoalSchema>;
