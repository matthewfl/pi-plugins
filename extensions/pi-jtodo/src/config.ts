/**
 * Optional per-user configuration: ~/.pi/agent/state/pi-jtodo/config.json
 * Missing or unreadable config falls back to defaults. Gate thresholds are
 * calibration constants (see constants.ts) and deliberately NOT configurable.
 * PI_JTODO_STATE_DIR overrides the state directory (embedding/tests).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_GATE_OBSERVATIONS, TODO_COMPLETION_GATE_MAX_ATTEMPTS } from "./constants.js";

export interface TodoConfig {
	enabled: boolean;
	/** Arm the auto-poke cycle when each session starts (TUI/RPC only). */
	autoPoke: boolean;
	/**
	 * Delay before the settle poke fires when the agent stops with open
	 * todos (pi-simple-goal restartDelayMs pattern). While the poke waits,
	 * any terminal input (the user starts typing) cancels it and pauses
	 * poking until the next agent run. 0 = immediate (pure jcode).
	 */
	pokeDelayMs: number;
	/** Turn-end re-validation budget before the gate stalls and disarms. */
	completionGateMaxAttempts: number;
	/** Cap on the turn-scoped observation log; oldest dropped first. */
	maxGateObservations: number;
	/**
	 * 0 = disabled (pure jcode: poke until the list settles). >0 disarms after
	 * N consecutive settles with no todo-state change (token-burn safety).
	 */
	maxConsecutivePokesWithoutProgress: number;
	idleNudge: boolean;
	idleNudgeAfterAssistantTurns: number;
	/** Line budget for the above-editor todo widget (header included). */
	widgetMaxLines: number;
	/** Idle starvation watchdog: re-fire the poke when the agent sits idle
	 *  with open todos (armed) longer than watchdogIdleMs. */
	watchdog: boolean;
	watchdogIdleMs: number;
	watchdogTickMs: number;
	/** Dead re-pokes without any activity before the cycle disarms. */
	watchdogMaxRePokes: number;
}

export const DEFAULT_CONFIG: TodoConfig = {
	enabled: true,
	autoPoke: true,
	pokeDelayMs: 20_000,
	completionGateMaxAttempts: TODO_COMPLETION_GATE_MAX_ATTEMPTS,
	maxGateObservations: MAX_GATE_OBSERVATIONS,
	maxConsecutivePokesWithoutProgress: 0,
	idleNudge: true,
	idleNudgeAfterAssistantTurns: 50,
	widgetMaxLines: 6,
	watchdog: true,
	watchdogIdleMs: 90_000,
	watchdogTickMs: 30_000,
	watchdogMaxRePokes: 3,
};

export function loadConfig(): TodoConfig {
	try {
		const stateDir =
			process.env.PI_JTODO_STATE_DIR ??
			path.join(os.homedir(), ".pi", "agent", "state", "pi-jtodo");
		const p = path.join(stateDir, "config.json");
		const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
		if (typeof parsed === "object" && parsed !== null) {
			return { ...DEFAULT_CONFIG, ...parsed };
		}
	} catch {
		// missing or unreadable config -> defaults
	}
	return { ...DEFAULT_CONFIG };
}
