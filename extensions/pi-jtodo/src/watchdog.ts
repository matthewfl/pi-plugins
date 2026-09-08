/**
 * Idle starvation watchdog — the liveness half of pi-simple-goal's watchdog,
 * applied to the todo auto-poke cycle (jcode's queued-followup starvation
 * watchdog, QUEUED_FOLLOWUP_STARVATION_TIMEOUT, is the same idea).
 *
 * Model: while auto-poke is armed and todos remain open, the agent should
 * NEVER sit idle for long — the turn-end machine pokes at every settle, so
 * a long quiet period means the follow-up was lost (dispatch consumed, run
 * never started, provider died silently). A periodic tick detects that
 * state and re-fires the poke, with a small cap so a truly wedged session
 * disarms instead of looping. Any real activity (agent start, turn end,
 * user input, our own successful send) postpones the fire window, and a
 * user abort (Esc) disarms the whole cycle via the normal path.
 */

export interface WatchdogDeps {
	now: () => number;
	isArmed: () => boolean;
	isIdle: () => boolean;
	incompleteCount: () => number;
	wasAborted: () => boolean;
	idleMs: number;
	maxRePokes: number;
	/** Re-send the auto-poke follow-up (fire-and-forget is fine). */
	onFire: (consecutiveRePokes: number) => void;
	/** Cap reached or abort races in: stop the cycle (`disarm` + notice). */
	onStarve: (reason: "cap" | "aborted") => void;
}

export interface Watchdog {
	tick: () => void;
	notifyActivity: () => void;
	/** Consecutive re-pokes with no real activity; exposed for tests. */
	getRePokes: () => number;
}

export function createWatchdog(deps: WatchdogDeps): Watchdog {
	let lastActivity = deps.now();
	let rePokes = 0;
	return {
		notifyActivity() {
			lastActivity = deps.now();
			rePokes = 0;
		},
		getRePokes: () => rePokes,
		tick() {
			const now = deps.now();
			if (!deps.isArmed() || !deps.isIdle()) {
				lastActivity = now;
				return;
			}
			if (deps.incompleteCount() === 0) {
				lastActivity = now;
				rePokes = 0;
				return;
			}
			if (now - lastActivity < deps.idleMs) return;
			lastActivity = now; // one shot per window regardless of outcome
			if (deps.wasAborted()) {
				deps.onStarve("aborted");
				return;
			}
			if (rePokes >= deps.maxRePokes) {
				deps.onStarve("cap");
				return;
			}
			rePokes += 1;
			deps.onFire(rePokes);
		},
	};
}
