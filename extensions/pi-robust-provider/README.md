# `@matthewfl/pi-robust-provider`

A [Pi](https://pi.dev) extension that adds aggressive, transport-level retries for unstable OpenAI-compatible LLM providers.

Pi already retries common transient failures. This package retries at the provider stream boundary with a broader error matcher, a longer time budget, and an idle-stream watchdog. That also covers callers that invoke provider streams directly, including subagents and background worker loops.

## When to use it

Use this package when an OpenAI Chat Completions-compatible provider, local model server, proxy, or network connection is unreliable enough that Pi's normal retry behavior gives up too quickly. It is particularly useful when:

- a self-hosted LLM server is restarted or temporarily unavailable;
- a gateway intermittently returns `404`, other `4xx`/`5xx` responses, or an empty response body;
- connections are refused, reset, timed out, or end before a terminal stream event;
- a request silently stalls without producing stream events;
- long-running agents or background workers should wait for the provider to recover instead of failing immediately.

This package is intentionally aggressive. Do not use it to hide persistent configuration, authentication, billing, or application errors. A broad retry policy can delay the final error and can increase the number of requests sent to a provider.

The extension currently wraps Pi's `openai-completions` API. It is not a retry wrapper for Anthropic Messages, OpenAI Responses, or other API types.

## Installation

Install the package with Pi:

```sh
pi install npm:@matthewfl/pi-robust-provider
```

To try it for one run without adding it to your settings:

```sh
pi -e npm:@matthewfl/pi-robust-provider
```

## Provider configuration

Create `~/.pi/agent/models.json` if it does not already exist. Configure an OpenAI Chat Completions-compatible provider and set its `api` to `openai-completions-retry`:

```json
{
  "providers": {
    "my-provider": {
      "baseUrl": "http://your-llm-server/v1",
      "apiKey": "local",
      "api": "openai-completions-retry",              // <--- enable the pi-robust-provider
      "models": [
        {
          "id": "my-model",
          "name": "My Model",
          "reasoning": false,
          "input": ["text"],
          "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0
          },
          "contextWindow": 128000,
          "maxTokens": 8192
        }
      ]
    }
  }
}
```

If the provider is already present in `models.json`, the only plugin-specific change is:
```json
"api": "openai-completions-retry"
```

Restart Pi or run `/reload` after installing the package or changing the configuration. On load, Pi displays a notification that `openai-completions-retry` was registered. Select the configured model normally with `/model`.

## Retry behavior

By default, each provider call:

- retries broad transient and network failures at a fixed 60-second cadence;
- keeps retrying for up to 30 minutes;
- treats 3 minutes without a stream event as a stalled attempt and retries it;
- never retries caller cancellation, recognized context-window overflow, quota, billing, or out-of-budget errors;
- displays retry progress and remaining time when an interactive UI is available.

A caller's `AbortSignal` is preserved, so pressing Escape can still cancel an interactive request.

## Configuration

The defaults can be changed with environment variables:

| Environment variable | Default | Purpose |
| --- | ---: | --- |
| `PI_ROBUST_PROVIDER_CADENCE_MS` | `60000` | Delay between failed attempts. |
| `PI_ROBUST_PROVIDER_MAX_TOTAL_MS` | `1800000` | Total retry budget for background and otherwise unattributed calls. |
| `PI_ROBUST_PROVIDER_MAIN_MAX_MS` | `1800000` | Total retry budget for Pi agent-loop calls. |
| `PI_ROBUST_PROVIDER_MAX` | `1000` | Maximum retry count guard. |
| `PI_ROBUST_PROVIDER_STATUS_MS` | `15000` | Idle time before showing a waiting status. |
| `PI_ROBUST_PROVIDER_ATTEMPT_TIMEOUT_MS` | `180000` | Idle time before treating one attempt as stalled. |
| `PI_ROBUST_PROVIDER_PATTERNS` | empty | Comma-separated, case-insensitive error substrings to retry. |

For example, retry every 15 seconds for at most 10 minutes:

```sh
PI_ROBUST_PROVIDER_CADENCE_MS=15000 \
PI_ROBUST_PROVIDER_MAX_TOTAL_MS=600000 \
PI_ROBUST_PROVIDER_MAIN_MAX_MS=600000 \
pi
```

The attempt timeout is an **idle** timeout. It resets whenever the provider emits a stream event, so a healthy response may stream for longer than this value.

## Repository

[github.com/matthewfl/pi-plugins/tree/master/extensions/pi-robust-provider](https://github.com/matthewfl/pi-plugins/tree/master/extensions/pi-robust-provider)

## License

[MIT](LICENSE)
