/**
 * Lenient input normalization — port of jcode-app-core's
 * normalize_todo_input (issue #357). Runs in the tool's prepareArguments
 * hook, before schema validation.
 *
 * Some providers intermittently emit tool arguments as JSON *strings*
 * instead of native types: the whole `todos` array as one stringified JSON
 * blob, individual items as stringified objects, or numeric fields like
 * `confidence` as "90". Strict validation would reject these, failing the
 * entire call. Legacy aliases (hill_climbability, alignment_score,
 * user_intention_alignment) are accepted at runtime but never advertised.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerce a numeric string ("90") or whole float (90.0) to an integer, and
 *  an empty string to null. Anything else passes through unchanged. */
function coerceValueToInteger(value: unknown): unknown {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed === "") return null;
		if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
		return value;
	}
	if (typeof value === "number" && !Number.isInteger(value)) {
		if (Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.trunc(value))) {
			return Math.trunc(value);
		}
	}
	return value;
}

function parseJsonIf(value: unknown, shape: "object" | "array"): unknown {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (trimmed === "") return null;
	try {
		const parsed = JSON.parse(trimmed);
		if (parsed === null) return null;
		if (shape === "object" && isPlainObject(parsed)) return parsed;
		if (shape === "array" && Array.isArray(parsed)) return parsed;
		return value;
	} catch {
		return value;
	}
}

const PLAN_SCORE_ALIASES = ["alignment_score", "user_intention_alignment"];
const GOAL_LOOP_ALIASES = ["hill_climbability"];

const NUMERIC_ITEM_KEYS = [
	"confidence",
	"completion_confidence",
	"closed_feedback_loop",
	"hill_climbability",
	"alignment_score",
	"user_intention_alignment",
	"end_to_end_ownership",
];

function adoptAlias(
	fields: Record<string, unknown>,
	target: string,
	aliases: string[],
): void {
	if (typeof fields[target] === "number" && Number.isInteger(fields[target])) return;
	for (const alias of aliases) {
		const v = fields[alias];
		if (typeof v === "number" && Number.isInteger(v)) {
			fields[target] = v;
			return;
		}
	}
}

/** Normalize raw todo-tool arguments; returns a fresh object (never mutates). */
export function normalizeTodoInput(raw: unknown): unknown {
	if (!isPlainObject(raw)) return raw;
	const input = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;

	// plan: stringified object or "" -> absent
	if ("plan" in input) {
		input.plan = parseJsonIf(input.plan, "object");
		if (input.plan === null) {
			delete input.plan;
		} else if (isPlainObject(input.plan)) {
			const plan = input.plan;
			for (const key of [...PLAN_SCORE_ALIASES, "understands_user_intent"]) {
				if (key in plan) plan[key] = coerceValueToInteger(plan[key]);
			}
			adoptAlias(plan, "understands_user_intent", PLAN_SCORE_ALIASES);
			for (const alias of PLAN_SCORE_ALIASES) delete plan[alias];
		}
	}

	for (const key of ["todos", "goals"]) {
		if (!(key in input)) continue;
		const entries = parseJsonIf(input[key], "array");
		if (entries === null) {
			delete input[key];
			continue;
		}
		if (!Array.isArray(entries)) continue;
		input[key] = entries.map((item) => {
			const parsed = parseJsonIf(item, "object");
			if (!isPlainObject(parsed)) return parsed;
			for (const numKey of NUMERIC_ITEM_KEYS) {
				if (numKey in parsed) parsed[numKey] = coerceValueToInteger(parsed[numKey]);
			}
			if (key === "goals") {
				// serde(alias) equivalent: pre-rename keys still load, but the
				// advertised schema only knows the new names.
				adoptAlias(parsed, "closed_feedback_loop", GOAL_LOOP_ALIASES);
				for (const alias of GOAL_LOOP_ALIASES) delete parsed[alias];
			}
			return parsed;
		});
	}
	return input;
}
