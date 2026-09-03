# `@matthewfl/pi-simple-goal`

A small [Pi](https://pi.dev) extension that keeps an agent working toward a persistent goal.

The extension injects the active goal into the agent's context, asks the agent to keep making concrete progress, and provides explicit tools for reporting that the goal is complete or impossible. If the agent stops while a goal is still active, the extension shows a status-line countdown ("goal will restart agent in 60s") and injects a follow-up message to start the agent working again once the countdown elapses. Pressing any key during the countdown cancels the restart and pauses the goal.

Watchdog timers provide an additional recovery path. They automatically restart agent work by sending a new or steering message when the agent has gone idle or a tool appears stuck—for example, after a network issue disconnects the agent and leaves the session idle.

## Installation

Install the package with Pi:

```sh
pi install npm:@matthewfl/pi-simple-goal
```

To try it without adding it to your settings:

```sh
pi -e npm:@matthewfl/pi-simple-goal
```

## Usage

Set a goal with the `/goal` command:

```text
/goal Add pagination to the users API and verify it with tests
```

Setting a goal immediately starts an agent turn. The goal is stored in the Pi session and restored across reloads, resumed sessions, and session-tree navigation.

Other commands:

```text
/goal show
/goal clear
```

You can also seed the initial goal straight from the command line with `--goal-set` (or the `PI_GOAL_SET` environment variable). The value is either the goal text itself or a path to a file whose contents become the goal (`~` is expanded; the file is trimmed):

```sh
pi --goal-set "Add pagination to the users API and verify it with tests"
pi --goal-set ./tasks/add-pagination.txt
```

On a fresh session this sets and persists the goal and immediately kicks off the agent loop in the TUI (in print mode it only sets the goal). It applies only while the session has no goal history at all, so an in-session `/goal clear` or `/goal <other>` is never overridden by the flag on reload.

While a goal is active, the extension:

- injects the goal and progress instructions into the system prompt;
- shows `goal active` in the footer status line;
- shows `goal will restart agent in Ns` in the status line when an agent run stops without completing the goal, and injects a follow-up message when the countdown elapses. This applies to every stop — plain stops, errors that survive retries, and turns that merely claim to be done in chat — so the agent can never stay stopped while a goal is active; only `goal_complete`, `goal_impossible`, a user pause, or `/goal clear` end the loop. Automatic restarts are spaced at least 60 seconds apart (a shorter configured delay is extended up to that minimum on quick re-stops, never dropped);
- pauses instead of restarting when you press a key during the countdown or press Escape—showing `goal paused (send a message to continue)`—and resumes (restarting the watchdogs) when you send a message. Pausing is tied to *observed user intervention* (the Escape keypress or typing); an aborted run is only treated as a user stop when an Escape was just seen. Machinery aborts (compaction, extension aborts, transport hiccups) silently schedule the restart countdown instead, so nothing short of you can stop the loop;
- exposes `goal_complete` so the agent can finish with a verification summary;
- exposes `goal_impossible` so the agent can report a blocker and stop cleanly;
- invokes a configured notification script as `script "message from the agent"` when the goal is marked complete or impossible;
- watches for idle sessions and long-running tools, then sends a message that triggers or steers the agent back toward the goal. A session opened or reloaded with an active goal and an idle agent starts the restart countdown immediately rather than waiting for the idle watchdog; pausing is per-session, so a `/reload` re-arms enforcement (press a key during the countdown to stay paused). Reloading mid-run just shows `goal active` — the countdown appears when that run ends.

## Configuration

The watchdog checks every 30 seconds by default. It restarts agent work after 5 minutes of inactivity or nudges the agent when one tool has been running for 30 minutes. When the agent stops with an unmet goal — or when a session is opened or reloaded with an active goal and the agent is not running — a 60 second countdown starts; the agent restarts when it ends, and any keypress cancels it.

Each option can be set via a CLI flag, an environment variable, or the `simpleGoal` object in `~/.pi/agent/settings.json`. Precedence is flag > environment variable > settings file > default.

| CLI flag | Environment variable | settings.json key | Default | Purpose |
| --- | --- | --- | ---: | --- |
| `--goal-restart-delay-ms` | `PI_GOAL_RESTART_DELAY_MS` | `restartDelayMs` | `60000` | Wait this long before restarting the agent after it stops. Any keypress cancels. `0` restarts immediately. |
| `--goal-watchdog-idle-ms` | `PI_GOAL_WATCHDOG_IDLE_MS` | `watchdogIdleMs` | `300000` | Restart work after this much idle time. |
| `--goal-watchdog-tool-ms` | `PI_GOAL_WATCHDOG_TOOL_MS` | `watchdogToolMs` | `1800000` | Nudge the agent after a tool runs this long. |
| `--goal-watchdog-tick-ms` | `PI_GOAL_WATCHDOG_TICK_MS` | `watchdogTickMs` | `30000` | Set how frequently the watchdog checks. |
| `--goal-notify-script` | `PI_GOAL_NOTIFY_SCRIPT` | `notifyScript` | - | Script invoked as `script "message from the agent"` when the goal is completed or marked impossible. |
| `--goal-set` | `PI_GOAL_SET` | - | - | Initial goal for a fresh session (inline text, or path to a file whose contents are used). Sets the goal and starts the agent loop in the TUI. Ignored once the session has any goal history. |

Set a watchdog timeout to `0` to disable that check. For example:

```sh
PI_GOAL_WATCHDOG_IDLE_MS=120000 pi
```

Settings file example (`~/.pi/agent/settings.json`):

```json
{
  "simpleGoal": {
    "restartDelayMs": 45000,
    "notifyScript": "~/bin/goal-notify.sh"
  }
}
```

The notification script receives a single argument, for example `Goal completed: <summary>` or `Goal impossible: <reason>`. A leading `~` in the path expands to your home directory. Script failures are reported as a warning notification and never block the agent.

## Development

The extension has no build step (pi loads TypeScript extensions directly). Run the behavioral test suite with:

```sh
npm test
```

The tests drive `goal.ts` with a mocked pi runtime, so they need a pi installation to resolve `@earendil-works/*` packages. Set `PI_CODING_AGENT_DIR` to the pi-coding-agent package root if `pi` is not on your `PATH`.

## Repository

[github.com/matthewfl/pi-plugins/tree/master/extensions/pi-simple-goal](https://github.com/matthewfl/pi-plugins/tree/master/extensions/pi-simple-goal)

## License

[MIT](LICENSE)
