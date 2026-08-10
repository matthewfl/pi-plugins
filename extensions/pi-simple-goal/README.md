# `@matthewfl/pi-simple-goal`

A small [Pi](https://pi.dev) extension that keeps an agent working toward a persistent goal.

The extension injects the active goal into the agent's context, asks the agent to keep making concrete progress, and provides explicit tools for reporting that the goal is complete or impossible. If the agent stops while a goal is still active, the extension injects a follow-up message to start the agent working again.

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

While a goal is active, the extension:

- injects the goal and progress instructions into the system prompt;
- injects a follow-up message if an agent run stops without completing the goal;
- exposes `goal_complete` so the agent can finish with a verification summary;
- exposes `goal_impossible` so the agent can report a blocker and stop cleanly;
- watches for idle sessions and long-running tools, then sends a message that triggers or steers the agent back toward the goal.

## Watchdog configuration

The watchdog checks every 30 seconds by default. It restarts agent work after 5 minutes of inactivity or nudges the agent when one tool has been running for 30 minutes.

| CLI flag | Environment variable | Default | Purpose |
| --- | --- | ---: | --- |
| `--goal-watchdog-idle-ms` | `PI_GOAL_WATCHDOG_IDLE_MS` | `300000` | Restart work after this much idle time. |
| `--goal-watchdog-tool-ms` | `PI_GOAL_WATCHDOG_TOOL_MS` | `1800000` | Nudge the agent after a tool runs this long. |
| `--goal-watchdog-tick-ms` | `PI_GOAL_WATCHDOG_TICK_MS` | `30000` | Set how frequently the watchdog checks. |

Set either timeout to `0` to disable that watchdog check. For example:

```sh
PI_GOAL_WATCHDOG_IDLE_MS=120000 pi
```

## Repository

[github.com/matthewfl/pi-plugins/tree/master/extensions/pi-simple-goal](https://github.com/matthewfl/pi-plugins/tree/master/extensions/pi-simple-goal)

## License

[MIT](LICENSE)
