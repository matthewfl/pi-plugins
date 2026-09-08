/**
 * /todos TUI viewer — a read-only overlay component showing the current
 * branch's todo state. Rendering chrome is pi-local (jcode's own TUI todo
 * view is a different design); the content mirrors the stored state.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { TodoState } from "./model.js";

export class TodoListComponent {
	private state: TodoState;
	private armed: boolean;
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(state: TodoState, armed: boolean, theme: Theme, onClose: () => void) {
		this.state = state;
		this.armed = armed;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const lines: string[] = [""];
		lines.push(
			truncateToWidth(
				th.fg("borderMuted", "─".repeat(3)) +
					th.fg("accent", " Todos ") +
					th.fg("borderMuted", "─".repeat(Math.max(0, width - 10))),
				width,
			),
		);
		lines.push("");

		const total = this.state.todos.length;
		const completed = this.state.todos.filter((t) => t.status === "completed").length;
		const cancelled = this.state.todos.filter((t) => t.status === "cancelled").length;
		const inProgress = this.state.todos.filter((t) => t.status === "in_progress").length;
		const pending = total - completed - cancelled - inProgress;
		const percent = total === 0 ? 0 : Math.round(((completed + cancelled) / total) * 100);
		lines.push(truncateToWidth(`  ${completed + cancelled}/${total} settled (${percent}%)`, width));
		if (inProgress) lines.push(truncateToWidth(`  ${inProgress} in progress`, width));
		if (pending) lines.push(truncateToWidth(`  ${pending} pending`, width));
		if (cancelled) lines.push(truncateToWidth(`  ${cancelled} cancelled`, width));
		lines.push(truncateToWidth(`  ${th.fg("dim", `auto-poke: ${this.armed ? "on" : "off"}`)}`, width));

		if (this.state.plan.user_intention) {
			lines.push("");
			lines.push(
				truncateToWidth(`  ${th.fg("muted", "Intention:")} ${this.state.plan.user_intention}`, width),
			);
		}

		if (total === 0) {
			lines.push("");
			lines.push(truncateToWidth(`  ${th.fg("dim", "No todos yet.")}`, width));
		} else {
			lines.push("");
			for (const todo of this.state.todos) {
				let icon: string;
				let color: "success" | "error" | "accent" | "dim";
				switch (todo.status) {
					case "completed":
						icon = "✓";
						color = "success";
						break;
					case "cancelled":
						icon = "✗";
						color = "error";
						break;
					case "in_progress":
						icon = "▶";
						color = "accent";
						break;
					default:
						icon = "○";
						color = "dim";
				}
				let text = todo.content;
				if (todo.status === "completed" || todo.status === "cancelled") {
					text = th.fg("dim", text);
				}
				const group = todo.group ? th.fg("muted", `[${todo.group}] `) : "";
				lines.push(
					truncateToWidth(
						`  ${th.fg(color, icon)} ${th.fg("accent", `#${todo.id}`)} ${group}${text}`,
						width,
					),
				);
			}
		}

		if (this.state.goals.length) {
			lines.push("");
			lines.push(truncateToWidth(`  ${th.fg("muted", "Goals:")}`, width));
			for (const goal of this.state.goals) {
				const g = goal.group ?? "(ungrouped)";
				const loop = goal.feedback_loop ? ` – ${goal.feedback_loop}` : "";
				const ownership =
					goal.end_to_end_ownership !== undefined
						? ` [ownership ${goal.end_to_end_ownership}]`
						: "";
				lines.push(
					truncateToWidth(
						`    ${th.fg("accent", g)}${th.fg("dim", loop)}${th.fg("dim", ownership)}`,
						width,
					),
				);
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
