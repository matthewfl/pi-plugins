# @matthewfl/pi-jtodo

A quality-gated `todo` tool for the [pi](https://github.com/earendil-works/pi-coding-agent) coding agent.

Most harness todo tools are checklists: the agent writes items, ticks them off, and nothing checks that "completed" meant *verified*. pi-jtodo ports the todo quality machinery from the **jcode** harness — confidence scores with tool-owned histories, plan and per-goal assessments, write-time ownership rejection, and turn-end validation gates — and adds pi-native reliability, recovery, and display features on top.

```
pi install npm:@matthewfl/pi-jtodo
```

> Registers the `todo` tool. If you use another todo extension (e.g. `@juicesharp/rpiv-todo`), remove it first — two extensions registering `todo` collide.

## Inspiration and lineage

The todo-tool family tree, as verified from each implementation's source:

| | Claude Code `TodoWrite` | opencode `todowrite` | jcode `todo` | typical pi todo extensions | **pi-jtodo** |
|---|---|---|---|---|---|
| **Lineage** | invented the concept + usage prose (2025) | copied Claude's prose verbatim, added `priority` + `cancelled` | opencode's schema/semantics, none of the prose — plus the whole quality layer | lightweight list trackers | **jcode's quality layer, ported to pi** |
| **Item schema** | `content`, `status` (3 states), `activeForm` | + `priority`, `cancelled` | + required `id`, `group`, `confidence`, `completion_confidence` | `content`/`status`/`priority` | = jcode (plus field-merge updates) |
| **What enforces "done"?** | nothing — prose only | nothing — prose only | ownership gate rejects the write; turn-end completion/spike gates; deferred quality digest | nothing | **full port** + early-stop + watchdog |
| **Pokes the agent when it stops early?** | no | no | auto-poke cycle, `/poke` re-arm | no | **port** + re-arm on new work + starvation watchdog |
| **Survives reload / tree jumps / compaction?** | n/a (single turn) | yes (SQLite) | app state, lost across restarts | session state | **replayed from the branch log**, including gate flags |
| **Tells the agent what its write actually changed?** | no | no | plan/goal assessment diffs only | no | **item-level `Changes:` digest** (names removed ids, cleared groups) |

What each layer contributed, concretely:

- **Claude Code** — the TodoWrite concept and the "when to use / when not to use" prose manual (opencode's 2025 description was a word-for-word copy of it).
- **opencode** — `content`/`status`/`priority`, full-replace write semantics, and the full-list JSON echo.
- **jcode** — everything that makes the list *load-bearing*: model-supplied ids, groups, the two confidence scores with tool-owned append-only histories, the `plan`/`goals` assessment objects, the whole-write ownership rejection, the deferred quality digest, and the auto-poke cycle. jcode deliberately carries no system-prompt guidance and keeps its calibration thresholds out of model-visible text; pi-jtodo keeps both disciplines.
- **@juicesharp/rpiv-todo** — the compact above-editor list display this extension's widget is modeled on.

pi-specific additions (not in any of the above): branch-log recovery of todo state *and* gate cycle flags across `/reload`, `/tree` jumps, and compaction; re-arm on new work (pi has no poke hotkey); a starvation watchdog that re-pokes when a follow-up was lost; the unchanged-signature early stop that halts a gate loop when the agent's scores aren't moving; update-style field inheritance with a `Changes:` digest; and the enriched widget strip (per-item confidence tails, per-goal table, poke-target fingers).

Deliberately **not** ported from jcode: the `/overnight` mission mode (presumes a supervisor/manifest apparatus), the guardrail and credential circuit breakers (pi and pi-robust-provider own that territory), and jcode's `/poke` hotkey (replaced by `/todos poke`).

## How it behaves

- **Writes are replace-on-membership, merge-on-fields**: `todos` present = the new list (omitted ids are deleted); omit the array to read. On an existing id, omitted optional fields (`group`, `completion_confidence`) are inherited; `group: ""` clears. Accepted writes append `Changes: 2 updated; 1 new; removed #x; group cleared on #y`.
- **Plan and goals are field-merged**: `plan` carries `user_intention` + `understands_user_intent`; each goal (one per group) carries `closed_feedback_loop` + `feedback_loop` + `end_to_end_ownership`. Omitted groups/fields are retained. All four histories are tool-owned — model-supplied history values are discarded.
- **Write-time gate**: a write that closes a group (or the implicit ungrouped list) without an honest `end_to_end_ownership` claim is **rejected whole** — stored state is returned unchanged with an actionable message naming the failing groups. A first plan write with severely low intent gets an immediate in-band continuation.
- **Turn-end gates** (when the agent settles): incomplete todos → auto-poke ("You have N incomplete todos. Continue working, or update the todo tool."). Fully settled → the deferred quality digest (intent/feedback-loop weak points), then the completion-confidence and confidence-spike gates — each naming the flagged `#id`s — with an attempt budget, an unchanged-signature early stop, and a done notice when validation passes.
- **Follow-ups are attributed**: pokes, digests, and gate challenges travel as custom messages (LLM-visible as user-role text, transcript-visible as `pi-jtodo/followup`), so reload/resume never re-renders them as user prompts.
- **Escape pauses, it does not silence** (pi-simple-goal pattern): a raw `\x1b` keypress within 5s of an aborted run marks it as the user's stop — the settle is quiet and the poke pauses until the user re-engages; the next agent run lifts the pause and re-arms. Aborts with no recent Escape behind them are machinery (compaction, `ctx.abort()`, transport, provider stacks mislabeling the interrupt as an error): their settle is quiet but the cycle stays armed and the starvation watchdog covers a lost continuation. The only sticky off is `/todos poke off`.

## Display

- **Above-editor strip**: intention header, value-ranked item lines (in_progress → pending → completed → cancelled) with status icons and `· conf N` tails, and a per-goal table (`Todo Goal | Settled | Conf | Own | Feedback`) with threshold-colored scores; `👉` marks the items that caused the most recent poke.
- **`/todos`** overlay: full list with plan, goals, and feedback-loop texts. `**/todos export**`, `**/todos clear**`, `**/todos poke on|off|status|trigger**`.

## Configuration

`~/.pi/agent/state/pi-jtodo/config.json` (all keys optional):

```json
{
	"enabled": true,
	"autoPoke": true,
	"completionGateMaxAttempts": 5,
	"maxGateObservations": 256,
	"maxConsecutivePokesWithoutProgress": 0,
	"idleNudge": true,
	"idleNudgeAfterAssistantTurns": 50,
	"watchdog": true,
	"watchdogIdleMs": 90000,
	"watchdogTickMs": 30000,
	"watchdogMaxRePokes": 3,
	"widgetMaxLines": 6
}
```

Gate calibration (the 96/60/15 thresholds and the 5-attempt budget) is intentionally **not** configurable — jcode keeps its calibration private from the model, and a knob the agent can turn is a knob the agent will turn.

## Development

```sh
npm test        # 34 tests: write-time gates (Suite A) + turn-end e2e via a scripted mock provider (Suite B)
```

Layout: `src/` (extension modules — `index.ts` is the entry), `tests/test-todo.cjs`.

## License

MIT — see [LICENSE](./LICENSE).
