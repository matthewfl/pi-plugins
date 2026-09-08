/**
 * Above-editor todo widget — the compact, always-on strip showing the
 * current branch's todo state, rendered with ctx.ui.setWidget and capped
 * at a small line budget (default 6) so it never crowds the editor.
 * Pi-only surface; jcode has no equivalent of pi's widget API.
 *
 * Two columns within the same row budget:
 *   left  — the todo list itself (header + value-ranked item lines)
 *   right — a goals table with spelled-out headers (Group / Settled /
 *           Conf / Loop / Own): per-goal progress, the group's current
 *           completion-confidence average, and its feedback-loop and
 *           end-to-end-ownership scores. Rows are ranked by "what would
 *           cause the agent to get poked if it stopped right now".
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { QUALITY_GATE_THRESHOLD } from "./constants.js";
import { todoConfidenceSummary } from "./gates.js";
import { goalGroupKey, type TodoGoal, type TodoItem, type TodoState } from "./model.js";

export const TODO_WIDGET_ID = "pi-jtodo";

export interface TodoWidgetComponent {
	render(width: number): string[];
	invalidate(): void;
	dispose?(): void;
}

/** Machine state the header tail should surface. */
export interface WidgetRuntime {
	armed: boolean;
	/** An Escape-paused cycle: suppressed until the user re-engages */
	escPaused?: boolean;
	gateAttempts: number;
	gateMaxAttempts: number;
	/** Ids of the todos that caused the most recent poke/gate challenge */
	pokeTargets?: ReadonlySet<string>;
}

const SETTLED = new Set(["completed", "cancelled"]);

// Pin the pass check to an unambiguous true green: this theme's "success"
// swatch is xterm-256 143 (olive #afd75f), which reads as yellow, and the
// theme ships no other green token. 38;5;40 = #00d700.
const GREEN_CHECK = "\x1b[38;5;40m✔\x1b[39m";
const GUTTER = 3;
const INTENTION_GAP = 12;
const TABLE_MAX_FRAC = 0.46; // the right table never takes more than ~half the width
const NAME_MAX = 18; // "(ungrouped)" (11) fits without truncation

// ============================================================================
// Left column: header + item lines
// ============================================================================

export function renderTodoWidgetLines(
	state: TodoState,
	runtime: WidgetRuntime,
	maxLines: number,
	width: number,
	th: Pick<Theme, "fg" | "bold">,
): string[] {
	if (state.todos.length === 0 || maxLines < 2) return [];
	const w = Math.max(10, width);

	const table = buildGoalsTable(state, maxLines, th);

	// Decide whether the table fits beside the list.
	let tableWidth = 0;
	if (table.length > 0) {
		tableWidth = Math.max(...table.map(visibleWidth));
		const leftWidth = w - tableWidth - GUTTER;
		if (tableWidth > Math.floor(w * TABLE_MAX_FRAC) || leftWidth < 24) {
			tableWidth = 0; // drop the table entirely rather than cramp the list
		}
	}
	const leftWidth = tableWidth > 0 ? w - tableWidth - GUTTER : w;

	const leftLines = buildLeftColumn(state, runtime, maxLines, leftWidth, th);

	const out: string[] = [];
	for (let i = 0; i < leftLines.length; i++) {
		const left = truncateToWidth(leftLines[i], leftWidth);
		const right = tableWidth > 0 ? (table[i] ?? "") : "";
		if (!right) {
			out.push(truncateToWidth(left, w));
			continue;
		}
		const gap = leftWidth - visibleWidth(left) + GUTTER;
		out.push(left + " ".repeat(Math.max(1, gap)) + right);
	}
	return out.map((l) => truncateToWidth(l, w));
}

function buildLeftColumn(
	state: TodoState,
	runtime: WidgetRuntime,
	maxLines: number,
	leftWidth: number,
	th: Pick<Theme, "fg" | "bold">,
): string[] {
	const settledCount = state.todos.filter((t) => SETTLED.has(t.status)).length;
	const allSettled = settledCount === state.todos.length;
	const summary = todoConfidenceSummary(state.todos);

	// Machine mode text (bottom line): the vocabulary of the notices the
	// user has been seeing.
	let status: string;
	if (!allSettled) {
		status = runtime.armed
			? "· auto-poke"
			: runtime.escPaused
				? "· poke paused"
				: "· poke off";
	} else if (summary.needs_validation) {
		status =
			runtime.gateAttempts > 0
				? `· gate ${runtime.gateAttempts}/${runtime.gateMaxAttempts}`
				: "· gate";
	} else {
		status = "· done";
	}

	// Header: the plan's user intention (what the agent thinks the user
	// wants), truncated to the column. The settled count and machine mode
	// moved to the bottom line, so the header answers "why", not "how far".
	const intention = (state.plan.user_intention ?? "").replace(/\s+/g, " ").trim();
	let header = th.fg("accent", th.bold("▣ Todos"));
	if (intention) {
		// INTENTION_GAP keeps a visual gap between the header text and the
		// right-hand goals table (user preference: ~12 cells of air).
		const avail = leftWidth - "▣ Todos".length - 1 - INTENTION_GAP;
		if (avail >= 1) {
			const text =
				intention.length > avail ? `${intention.slice(0, Math.max(1, avail - 1))}…` : intention;
			header += " " + th.fg("muted", text);
		}
	}

	// Value-ranked ordering: the strip truncates the tail, so the tail must
	// be the least valuable. in_progress (the live work) always leads, then
	// pending in declaration order (roughly plan order), completed after
	// that, cancelled last. Stable sort keeps declaration order as tiebreak.
	const RANK = new Map<string, number>([
		["in_progress", 0],
		["pending", 1],
		["completed", 2],
		["cancelled", 3],
	]);
	const ordered = state.todos
		.map((t, i) => ({ t, i }))
		.sort((a, b) => (RANK.get(a.t.status) ?? 1) - (RANK.get(b.t.status) ?? 1) || a.i - b.i)
		.map((x) => x.t);

	// Budget: header(1) + items + bottom status line (always present).
	const itemBudget = maxLines - 2;
	const shown = ordered.slice(0, Math.max(0, itemBudget));
	const hidden = ordered.length - shown.length;

	const lines: string[] = [header];
	for (const t of shown) {
		lines.push(formatItemLine(t, th, runtime.pokeTargets));
	}
	let overflow = "";
	if (hidden > 0) {
		const hiddenOpen = ordered.slice(ordered.length - hidden);
		const pend = hiddenOpen.filter((t) => t.status !== "completed" && t.status !== "cancelled").length;
		overflow = ` · … ${hidden} more${pend > 0 ? ` (${pend} open)` : ""}`;
	}
	lines.push(th.fg("dim", `  ${settledCount}/${state.todos.length} settled ${status}${overflow} — /todos`));
	return lines;
}

/**
 * Item lines carry the visual pass/warn semantics:
 *   🚧 in progress   🔲 pending   ❌ cancelled
 *   ✔ (green) completed at the bar 🟡 (yellow) completed BELOW the bar (gate bait)
 * plus a 👉 prefix on the items that caused the most recent poke.
 */
function itemStatus(t: TodoItem): { icon: string; textColor: "success" | "error" | "accent" | "dim" | "warning"; failing: boolean } {
	if (t.status === "completed") {
		const conf = t.completion_confidence;
		if (conf === undefined || conf < QUALITY_GATE_THRESHOLD) {
			// 🟡 yellow light for "gate bait": user-verified that ⚠️ (VS16)
			// cannot be spacing-fixed — the wide glyph hides the name-column
			// shift while pushing the numbers +1. 🟡 is a true double-width
			// single-codepoint emoji: no VS16, no cell-eating, grid-exact.
			return { icon: "🟡", textColor: "warning", failing: true };
		}
		// ✔ (no VS16) — GREEN_CHECK pins the true-green color at render time.
		return { icon: "✔", textColor: "success", failing: false };
	}
	if (t.status === "cancelled") return { icon: "❌", textColor: "error", failing: false };
	if (t.status === "in_progress") return { icon: "🚧", textColor: "accent", failing: false };
	return { icon: "🔲", textColor: "dim", failing: false };
}

function formatItemLine(
	t: TodoItem,
	th: Pick<Theme, "fg" | "bold">,
	pokeTargets: ReadonlySet<string> | undefined,
): string {
	const { icon, textColor, failing } = itemStatus(t);
	const iconText = t.status === "completed" && !failing ? GREEN_CHECK : th.fg(textColor, icon);
	// Uniform 2-cell icon column: 🚧/🔲/❌/🟡 are true double-width emoji;
	// ✔ is a single-cell glyph and gets padded. Every icon cell is
	// exactly 2 columns, so every column after it aligns on all fonts.
	const TWO_CELL = new Set(["🚧", "🔲", "❌", "🟡"]);
	const iconCell = TWO_CELL.has(icon) ? iconText : iconText + " ";
	const poked = pokeTargets?.has(t.id) ? "👉 " : "";
	const text = SETTLED.has(t.status)
		? failing
			? th.fg("warning", t.content)
			: th.fg("dim", t.content)
		: t.content;
	const group = t.group ? th.fg("dim", `[${t.group}] `) : "";
	const conf = t.status === "completed" ? t.completion_confidence : t.confidence;
	const tail =
		conf !== undefined && conf !== null
			? failing
				? th.fg("warning", ` · conf ${conf}`)
				: th.fg("dim", ` · conf ${conf}`)
			: "";
	return `  ${poked}${iconCell} ${th.fg("accent", `#${t.id}`)} ${group}${text}${tail}`;
}

// ============================================================================
// Right column: goals table
// ============================================================================

interface GoalRow {
	name: string;
	settled: number;
	total: number;
	done: boolean;
	conf: number | undefined;
	loop: number | undefined;
	own: number | undefined;
	rank: number;
	decl: number;
}

export function goalTableRows(state: TodoState): GoalRow[] {
	const rows: GoalRow[] = [];
	// The table is driven by the UNION of goal entries and todo group labels:
	// a group written into todos but not yet assessed in `goals` must still
	// render (with "–" scores) — otherwise the right side looks like it
	// "doesn't start displaying" whenever the agent adds new grouped work
	// before it next updates its goal assessments.
	const goalByKey = new Map<string | null, { g: TodoGoal; decl: number }>();
	(state.goals ?? []).forEach((g: TodoGoal, decl) => {
		goalByKey.set(goalGroupKey(g.group), { g, decl });
	});
	const keys: { key: string | null; decl: number }[] = [];
	for (const [key, entry] of goalByKey) keys.push({ key, decl: entry.decl });
	state.todos.forEach((t, i) => {
		const key = goalGroupKey(t.group);
		if (!goalByKey.has(key) && !keys.some((k) => k.key === key)) {
			keys.push({ key, decl: (state.goals?.length ?? 0) + i });
		}
	});
	for (const { key, decl } of keys) {
		const items = state.todos.filter((t) => goalGroupKey(t.group) === key);
		if (items.length === 0) continue; // goals without work in this branch stay hidden
		const g = goalByKey.get(key)?.g;
		const settled = items.filter((t) => SETTLED.has(t.status)).length;
		const done = settled === items.length;
		const summary = todoConfidenceSummary(items);
		const owns = g?.end_to_end_ownership;
		const open = items.some((t) => t.status === "in_progress")
			? 0
			: !done
				? 1
				: summary.needs_validation || owns === undefined || owns < QUALITY_GATE_THRESHOLD
					? 2 // settled but a gate would still act on it
					: 3;
		rows.push({
			name: key ?? "(ungrouped)",
			settled,
			total: items.length,
			done,
			conf: summary.completion_average,
			loop: g?.closed_feedback_loop,
			own: owns,
			rank: open,
			decl,
		});
	}
	rows.sort((a, b) => a.rank - b.rank || a.decl - b.decl);
	return rows;
}

/** Table lines: header row first, then one row per goal (+ overflow row). */
export function buildGoalsTable(
	state: TodoState,
	maxLines: number,
	th: Pick<Theme, "fg" | "bold">,
): string[] {
	const rows = goalTableRows(state);
	const rowBudget = maxLines - 1; // header row consumes one line
	if (rows.length === 0 || rowBudget < 2) return [];

	const nameW = Math.min(
		NAME_MAX,
		Math.max("Todo Goal".length, ...rows.map((r) => Math.min(r.name.length, NAME_MAX))),
	);
	// Fixed-width columns joined by single spaces: headers and cells pad to
	// the same widths, so rows and headings share column edges. Own is 4
	// wide (values reach "100%"); the ✔ marker is padded to 2 cells so it
	// matches the double-width emoji markers visually.
	const header =
		"   " + ["Todo Goal".padEnd(nameW), "Settled", "Conf", "Own ", "Feedback"].join(" ");

	const dataBudget = rowBudget - (rows.length > rowBudget ? 1 : 0);
	let shown = rows;
	let footer = "";
	if (rows.length > rowBudget) {
		const hidden = rows.slice(dataBudget);
		shown = rows.slice(0, Math.max(0, dataBudget));
		const openLeft = hidden.filter((r) => !r.done).length;
		footer = `… ${hidden.length} more group${hidden.length === 1 ? "" : "s"}${openLeft > 0 ? ` (${openLeft} open)` : ""}`;
	}

	const lines: string[] = [th.fg("dim", header)];
	for (const r of shown) {
		// Row marker: the group's machine-facing state, mirroring the item icons.
		const marker =
			r.done && r.rank < 3
				? th.fg("warning", "🟡") // true 2-cell emoji, same width class as GREEN_CHECK+" "
				: r.done
					? GREEN_CHECK + " " // widen the 1-cell glyph to the emoji width
					: r.rank === 0
						? "🚧"
						: "🔲";
		const name = r.name.length > nameW ? `${r.name.slice(0, Math.max(0, nameW - 1))}…` : r.name;
		const namePadded = name.padEnd(nameW);
		const gatedCell = (v: number | undefined, width: number) => {
			if (v === undefined) return th.fg("dim", "–".padStart(width));
			const cell = `${v}%`.padStart(width);
			return v < QUALITY_GATE_THRESHOLD ? th.fg("warning", cell) : th.fg("success", cell);
		};
		const cells =
			" " + // join between name column and Settled, matching the header
			th.fg("dim", `${(r.settled + "/" + r.total).padStart(7)}`) +
			" " +
			gatedCell(r.conf, 4) +
			" " +
			gatedCell(r.own, 4) +
			" " +
			gatedCell(r.loop, 8);
		const styledName = r.done
			? r.rank < 3
				? th.fg("warning", namePadded)
				: th.fg("dim", namePadded)
			: r.rank === 0
				? th.fg("accent", namePadded)
				: namePadded;
		lines.push(`${marker} ${styledName}${cells}`);
	}
	if (footer) lines.push(th.fg("dim", footer));
	return lines;
}

export function makeTodoWidget(
	getState: () => TodoState,
	getRuntime: () => WidgetRuntime,
	maxLines: number,
): (tui: unknown, theme: Theme) => TodoWidgetComponent {
	return (_tui, theme) => {
		// Stateless render (thunks read live state), but keep honest dirty
		// bookkeeping so any pi-tui caching that consults invalidate() sees a
		// real state transition instead of a no-op.
		let dirty = true;
		return {
			render(width: number) {
				dirty = false;
				return renderTodoWidgetLines(getState(), getRuntime(), maxLines, width, theme);
			},
			invalidate() {
				dirty = true;
			},
		};
	};
}
