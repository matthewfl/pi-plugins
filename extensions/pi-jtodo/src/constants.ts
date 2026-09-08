/**
 * Constants — thresholds and model-visible texts, verbatim from
 * jcode-base/src/todo.rs. These are private calibration: never interpolate
 * them into schema descriptions, continuations, digests, or notices, so the
 * model cannot learn to target the evaluator instead of reporting honestly.
 */

export const TODO_TOOL_NAME = "todo";

/** Minimum passing score for 0-100 quality assessments. */
export const QUALITY_GATE_THRESHOLD = 96;
/** Goals scoring below this are considered open-loop. */
export const LOW_CLOSED_FEEDBACK_LOOP = QUALITY_GATE_THRESHOLD;
/** Below this the agent does not yet understand the user's intent. */
export const LOW_INTENT_UNDERSTANDING = QUALITY_GATE_THRESHOLD;
/**
 * Below this score on the very first plan write the agent is admitting it
 * does not know the task; worth one immediate nudge. Every other write-time
 * check is deferred to the turn-end digest.
 */
export const SEVERE_INTENT_MISUNDERSTANDING = 60;
/** A completed todo whose final recorded confidence jump is at least this. */
export const TODO_CONFIDENCE_SPIKE = 15;
/** Turn-end re-validation budget before the gate gives up and disarms. */
export const TODO_COMPLETION_GATE_MAX_ATTEMPTS = 5;
/** Upper bound on retained turn-scoped observations; oldest dropped first. */
export const MAX_GATE_OBSERVATIONS = 256;

// Window in which a raw Escape keypress is considered the cause of an aborted
// run (user stopped it on purpose). Outside this window an abort is machinery
// (compaction, ctx.abort(), transport) and the poke cycle stays armed.
// Same value and rationale as pi-simple-goal's ESCAPE_ABORT_WINDOW_MS.
export const ESCAPE_ABORT_WINDOW_MS = 5_000;

/** customType for all synthetic gate follow-ups (custom session messages). */
export const FOLLOWUP_CUSTOM_TYPE = "pi-jtodo/followup";

// Display-hidden session entries marking auto-poke arm/disarm transitions.
// The branch walker replays these so reload / tree navigation reset the
// gate cycle exactly where the live machine reset it — without them,
// transcript flags are monotone and a post-rearm reload would inherit the
// previous cycle's digestDelivered/spikeChallenged.
export const CYCLE_CUSTOM_TYPE = "pi-jtodo/cycle";

// ----------------------------------------------------------------------------
// Model-visible continuations — verbatim from jcode-base/src/todo.rs
// ----------------------------------------------------------------------------

/** Immediate nudge for a severely low first intent assessment (in-band). */
export const TODO_INTENT_UNDERSTANDING_CONTINUATION_MESSAGE =
	"Your understanding of the user's intent is not high enough. Re-read the request and think harder about what the user actually wants and left implicit, using the conversation and codebase as evidence. Do not ask the user; resolve the ambiguity yourself, then update the plan's user intention and understands_user_intent.";

/** Ownership gate rejection. Names the field to raise and discloses the rejection. */
export const TODO_OWNERSHIP_CONTINUATION_MESSAGE =
	"Your end-to-end ownership is not high enough to complete this goal. Take ownership of the full user outcome, not just the immediate implementation. Follow the work through every relevant integration and runtime path, resolve consequential gaps, validate the complete workflow, and finish the necessary follow-through. Then call the todo tool again, setting a higher `end_to_end_ownership` on the goal for this group; until that field is raised the write is rejected and the stored todo list is left unchanged.";

/** Turn-end completion-confidence gate. */
export const TODO_COMPLETION_CONTINUATION_MESSAGE =
	"[automated todo completion gate - not a user message] Your completion confidence is missing or not high enough. Do not reply conversationally or wait for the user. Instead: Validate the completed result more thoroughly with concrete evidence, address any remaining issues, then call the todo tool again with updated completion_confidence values that reflect the validation you performed.";

/** Turn-end confidence-spike gate. */
export const TODO_CONFIDENCE_SPIKE_CONTINUATION_MESSAGE =
	"[automated todo completion gate - not a user message] Your completion confidence rose too sharply to count as independently validated. Do not reply conversationally or wait for the user. Instead: recheck the completed result using concrete evidence, address any issues you find, then call the todo tool again with completion_confidence values that reflect the validation you performed.";

/** Turn-end digest header. Framed as "double-check", never a refusal. */
export const TODO_GATE_DIGEST_PREFIX =
	"[automated todo quality review - not a user message] Before you treat this turn as finished, double-check the weak points it surfaced. Do not reply conversationally or wait for the user.";

// ----------------------------------------------------------------------------
// Display-only notices (jcode DisplayMessage::system strings; /poke adapted
// to /todos poke). Shown via ctx.ui.notify, never sent to the model.
// ----------------------------------------------------------------------------

export const NOTICE_POKE_OFF_HINT = "/todos poke off to stop.";
export const NOTICE_DIGEST_QUEUED =
	"🔎 We asked the agent to double-check this turn's weak points.";
export const NOTICE_COMPLETION_CHALLENGED =
	"🛑 The agent marked its work done without strong enough validation. We asked it to double-check.";
export const NOTICE_SPIKE_CHALLENGED =
	"🛑 The agent's confidence jumped suddenly. We asked it to verify that independently.";
export const NOTICE_GATE_STALLED =
	"⚠️ We nudged the agent several times but its validation still isn't holding up. We stopped poking; review the remaining todos yourself.";
export const NOTICE_GATE_UNCHANGED =
	"⚠️ The agent re-validated but its completion confidence did not move, so further nudges would only repeat themselves. We stopped poking; review the completed todos yourself. /todos poke on to resume.";
