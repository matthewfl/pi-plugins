/**
 * Pure delayed-poke scheduler (pi-simple-goal restartDelayMs pattern).
 *
 * The settle poke can be delayed (config.pokeDelayMs): while a poke is
 * pending, any terminal input cancels it and pauses poking until the next
 * agent run (see index.ts). This module owns only the timer lifecycle so it
 * can be unit-tested without pi. A delayMs of 0 fires synchronously, which
 * preserves the immediate (pure jcode) behavior with no branching at the
 * call sites.
 */

export interface PokeScheduler {
	/** Schedule a delayed poke, replacing any pending one. */
	schedule(fire: () => void): void;
	/** Cancel the pending poke (if any). */
	cancel(): void;
	/** Whether a poke is currently scheduled and waiting. */
	isPending(): boolean;
	/** Epoch ms when the pending poke fires; 0 when none pending. */
	deadlineAt(): number;
}

export function createPokeScheduler(delayMs: number): PokeScheduler {
	let timer: NodeJS.Timeout | undefined;
	let deadline = 0;

	const clear = (): void => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		deadline = 0;
	};

	return {
		schedule(fire: () => void): void {
			if (delayMs <= 0) {
				fire();
				return;
			}
			clear();
			deadline = Date.now() + delayMs;
			timer = setTimeout(() => {
				timer = undefined;
				deadline = 0;
				fire();
			}, delayMs);
			if (typeof timer.unref === "function") timer.unref();
		},
		cancel: clear,
		isPending: (): boolean => timer !== undefined,
		deadlineAt: (): number => deadline,
	};
}
