/**
 * pi-robust-provider — transport-level robust retry for provider streams.
 *
 * The main-session retry that pi's own `retry.*` settings drive only reaches
 * requests that flow through AgentSession/ModelRuntime with the narrow built-in
 * matcher, and OM-style worker loops that call `streamSimple`/`agentLoop`
 * directly get `maxRetries -> 0`. This plugin fixes that at the provider-stream
 * boundary, generically:
 *
 *   - It registers a NEW compat api id, `openai-completions-retry`, whose
 *     `stream`/`streamSimple` wrap the built-in `openai-completions` api's
 *     streams with a time-budgeted, fixed-cadence, broad-matcher retry.
 *   - Switching a provider's models.json `"api"` from `"openai-completions"`
 *     to `"openai-completions-retry"` makes EVERY stream for that provider —
 *     the main interactive session, subagents, OM worker loops, and any other
 *     caller that resolves by model.api — survive a server that goes down for
 *     a long time, keeping the request retried rather than giving up.
 *
 * Retry semantics:
 *   - Retryable = pi's transient provider class PLUS the "weird" cases a flaky
 *     self-hosted server emits (standalone 4xx like transient 404s, bodyless
 *     "404 status code (no body)" responses, "has no body", connection drops).
 *   - Cadence = fixed ~60s between attempts, rather than pi's 8s-capped exponential.
 *   - Budget = total wall-clock per call, 30 minutes by default for BOTH background
 *     workers and the interactive session, so a server that goes down keeps being
 *     retried for the targeted outage window. Lower robust-provider-main-max-ms if
 *     you want interactive turns to give up sooner than background work.
 *   - Stall watchdog = each attempt runs under a per-attempt abort timer (the cadence),
 *     so a server that goes silent mid-stream is treated as a retryable failure instead
 *     of freezing the call.
 *   - Sleep is abortable on the request's AbortSignal, and each attempt emits a
 *     notify/log with the elapsed time + remaining budget.
 *
 * Config (flags/env, all optional — sensible defaults):
 *   flag `robust-provider-cadence-ms` / PI_ROBUST_PROVIDER_CADENCE_MS  (60000)
 *   flag `robust-provider-max-total-ms`/ PI_ROBUST_PROVIDER_MAX_TOTAL_MS
 *        (1800000 = 30 min; the per-call wall-clock budget)
 *   flag `robust-provider-main-max-ms` / PI_ROBUST_PROVIDER_MAIN_MAX_MS
 *        (1800000 = 30 min; budget for the interactive main session path —
 *         same as the worker budget by default; lower for quicker interactive give-up)
 *   flag `robust-provider-max`       / PI_ROBUST_PROVIDER_MAX       (1000)
 *   flag `robust-provider-status-ms`  / PI_ROBUST_PROVIDER_STATUS_MS (15000)
 *        (silent in-flight threshold — shows a working-message hint when a request makes
 *         no progress for this long; also drives a live "retrying" status during the
 *         between-attempts cadence sleep when the interactive session's UI is available)
 *   flag `robust-provider-attempt-timeout-ms` / PI_ROBUST_PROVIDER_ATTEMPT_TIMEOUT_MS
 *        (180000 = 3 min; per-attempt idle stall abort — deliberately longer than the 60s
 *         cadence so a slow first token on a big prompt, e.g. compaction summarization over
 *         a full context, isn't killed mid-wait into an endless self-inflicted retry loop)
 *   flag `robust-provider-patterns`  / PI_ROBUST_PROVIDER_PATTERNS  (extra substrings)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import {
	getApiProvider,
	type StreamFunction,
	registerApiProvider,
	unregisterApiProviders,
} from "@earendil-works/pi-ai/compat";

const API_ID = "openai-completions-retry";
const BASE_API = "openai-completions";

type StreamFn = (
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions | StreamOptions,
) => AssistantMessageEventStream;

// --- config helpers (flag > env > default) ---
function num(pi: ExtensionAPI, flag: string, env: string, def: number): number {
	const f = pi.getFlag?.(flag);
	if (typeof f === "string" && f.trim()) {
		const n = Number(f.trim());
		if (Number.isFinite(n) && n >= 0) return n;
	}
	const e = process.env[env];
	if (e && e.trim()) {
		const n = Number(e.trim());
		if (Number.isFinite(n) && n >= 0) return n;
	}
	return def;
}

function patterns(pi: ExtensionAPI): string[] {
	const f = pi.getFlag?.("robust-provider-patterns");
	const raw =
		typeof f === "string" && f.trim()
			? f
			: process.env.PI_ROBUST_PROVIDER_PATTERNS;
	if (!raw) return [];
	return raw
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
}

// --- broad retryability: pi's transient class + weird/4xx/bodyless cases ---
function isBroadRetryable(
	stopReason: string | undefined,
	errorMessage: string | undefined,
	extra: string[],
): boolean {
	if (stopReason !== "error" || !errorMessage) return false;
	const msg = errorMessage.toLowerCase();

	// Never retry context-overflow / quota — route to compaction / fail, not retry.
	const NON_RETRYABLE = [
		"context length",
		"maximum context",
		"context window",
		"maximum.?number of tokens",
		"prompt is too long",
		"too long",
		"reduce the length",
		"insufficient_quota",
		"out of budget",
		"quota exceeded",
		"billing",
	];
	if (NON_RETRYABLE.some((p) => new RegExp(p, "i").test(msg))) return false;

	// Mirror pi's built-in transient provider pattern.
	const builtIn = [
		"overloaded",
		"rate.?limit",
		"too many requests",
		"429",
		"500",
		"502",
		"503",
		"504",
		"524",
		"service.?unavailable",
		"server.?error",
		"internal.?error",
		"provider.?returned.?error",
		"network.?error",
		"connection.?error",
		"connection.?refused",
		"connection.?lost",
		"other side closed",
		"fetch failed",
		"upstream.?connect",
		"reset before headers",
		"socket hang up",
		"socket connection was closed",
		"timed?out",
		"timeout",
		"terminated",
		"getaddrinfo",
		"ENOTFOUND",
		"EAI_AGAIN",
		"websocket.?closed",
		"websocket.?error",
		"ended without",
		"stream ended before message_stop",
		"stream ended before a terminal response event",
		"http2 request did not get a response",
		"retry delay",
		"you can retry your request",
		"try your request again",
		"please retry your request",
		"ResourceExhausted",
		"\\(no body\\)", // "404 status code (no body)" / "403 status code (no body)" ...
		"has no body",
		"\\b4\\d{2}\\b", // standalone 4xx token (transient 404/403/408/413 from a flaky proxy)
	];
	if (builtIn.some((p) => new RegExp(p, "i").test(msg))) return true;
	return extra.some((p) => msg.includes(p));
}

/**
 * Compress a terminal provider error into a short, human-actionable tag for status / retry
 * messages: the HTTP status when present ("404"), else a network error code ("ECONNREFUSED"),
 * else a normalized failure class ("connection error"), else the leading bytes of the message.
 * Only the TEXT of AssistantMessage.errorMessage is available here (the raw Error lives in
 * per-provider internals), so this is best-effort extraction from pi's formatted strings.
 */
function errorTag(message: unknown): string {
	const msg = String(message ?? "").trim();
	if (!msg) return "unknown error";
	const net = msg.match(/\b(ECONNREFUSED|ECONNRESET|ECONNABORTED|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|EPIPE|ETIMEDOUT|EAI_AGAIN)\b/);
	if (net) return net[1].toUpperCase();
	const statusMatch =
		msg.match(/\((\d{3})\)/) ||					// pi's formatProviderError: "prefix (404): {body}"
		msg.match(/\bstatus(?:\s*code)?[^0-9]{0,6}(\d{3})/i) ||	// "status code 429" / "status: 500"
		msg.match(/^(\d{3})\s*:/);						// "404: {body}"
	if (statusMatch) return statusMatch[1];
	const bare = msg.match(/\b(4\d{2}|5\d{2})\b/);				// any standalone 4xx/5xx token
	if (bare) return bare[1];
	const klass = msg.match(
		/\b(connection (?:error|refused|closed|lost)|fetch failed|socket hang up|terminated|no body|no response|no progress|timed? ?out|overloaded|rate.?limit|too many requests|unavailable|invalid api key|unauthorized|quota)\b/i,
	);
	if (klass) return klass[1].toLowerCase();
	return msg.slice(0, 60);
}

/**
 * Wrap a provider stream function so a terminal failure re-invokes the stream (a fresh request)
 * after a fixed cadence, up to a total wall-clock budget. Content events stream through
 * immediately; only the terminal `error` event is held until the retry decision.
 *
 * Crucially, each attempt runs under a per-attempt abort watchdog (attemptTimeoutMs, default
 * 180s — deliberately decoupled from the 60s retry cadence, see below): a server
 * that goes down often manifests as a *silent hang* (socket stalls, no terminal event) rather
 * than a quick HTTP error, and a plain `for await` over the inner stream would never surface an
 * error for us to retry. The watchdog aborts the attempt-scoped signal when no terminal event
 * arrives in time, converting the stall into a retryable failure — which is what lets a
 * long-lived outage be survived instead of freezing the call.
 */
function withRobustStream(
	inner: StreamFn,
	opts: {
		cadenceMs: number;
		maxTotalMs: number;
		maxAttempts: number;
		extra: string[];
		attemptTimeoutMs?: number;
		notify: (msg: string, level?: "info" | "warning" | "error") => void;
		statusMs?: number;
		setWorking?: (m?: string) => void;
	}): StreamFn {
	const { cadenceMs, maxTotalMs, maxAttempts, extra, notify, statusMs = 15000, setWorking } = opts;
	// Per-attempt idle budget. Deliberately LONGER than the retry cadence: a large prompt (e.g.
	// compaction summarization over a big context) on a congested/recovering gateway can take
	// minutes to emit its first token. Tying the stall abort to the 60s cadence would kill every
	// such attempt before its first byte — an endless, self-inflicted retry loop that LOOKS like
	// the server never came back. Cadence governs re-firing a FAILED request; this governs how
	// long we tolerate silence WITHIN one attempt.
	const attemptTimeoutMs = opts.attemptTimeoutMs ?? 180000;

	return (model, context, options) => {
		const out = createAssistantMessageEventStream();
		const signal = (options as SimpleStreamOptions | undefined)?.signal;

		// Working-message emitter, wired to the captured ctx.ui handle (no-op when headless).
		const emitWorking = (m: string | undefined) => { try { setWorking?.(m); } catch { /* ignore */ } };
		const clearWorking = () => { try { setWorking?.(undefined); } catch { /* ignore */ } };
		// Target host — for "what are we actually failing to reach?" debugging.
		const host = (() => {
			try {
				return new URL(String((model as { baseUrl?: string }).baseUrl ?? "")).host;
			} catch {
				return String((model as { baseUrl?: string }).baseUrl ?? "");
			}
		})();
		// Error tag of the most recent failed attempt, shown in subsequent status messages.
		let lastTag = "";

		const sleep = (ms: number): Promise<boolean> =>
			new Promise((resolve) => {
				if (signal?.aborted) return resolve(false);
				const t = setTimeout(() => resolve(true), Math.max(0, ms));
				signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(t);
						resolve(false);
					},
					{ once: true },
				);
			});

		const runAttempt = async (attempt: number, deadline: number): Promise<void> => {
			const started = Date.now();
			const remaining = deadline - Date.now();
			const attemptBudget = Math.max(250, Math.min(attemptTimeoutMs, remaining));

			// Per-attempt abort controller chained to the caller's signal. Aborted either by the
			// caller OR by the no-progress watchdog below.
			const ac = new AbortController();
			let timedOut = false;
			const onOuterAbort = () => ac.abort();
			if (signal?.aborted) ac.abort();
			signal?.addEventListener("abort", onOuterAbort, { once: true });

			// Idle timer, NOT an absolute one: it is reset on every streamed event, so a healthy
			// generation that streams for many minutes is never aborted. It only fires when the
			// inner stream makes NO progress within attemptBudget — the silent-hang case.
			let watchdog: ReturnType<typeof setTimeout> | undefined;
			const armWatchdog = () => {
				clearTimeout(watchdog);
				watchdog = setTimeout(() => {
					timedOut = true;
					ac.abort();
				}, attemptBudget);
			};
			armWatchdog();

			// Slow-request status: if the attempt makes no progress for `statusMs` (no content/tool
			// event), surface a "waiting for model…" message so the UI never looks frozen while the
			// server is thinking or is down-but-not-failing. Reset on every stream event, exactly
			// like the stall watchdog (which fires later, at attemptBudget).
			let slowTimer: ReturnType<typeof setTimeout> | undefined;
			const armSlow = () => {
				clearTimeout(slowTimer);
				slowTimer = setTimeout(() => {
					emitWorking(`robust-provider: waiting for model (${Math.max(1, Math.ceil(statusMs / 1000))}s+, attempt ${attempt + 1}${lastTag ? `, last: ${lastTag}` : ""})…`);
				}, statusMs);
			};
			armSlow();

			let lastError: AssistantMessage | undefined;
			try {
				// Pass our attempt-scoped signal into the inner stream so the underlying HTTP
				// request is cancellable on stall.
				for await (const ev of inner(model, context, { ...(options as object), signal: ac.signal } as Partial<SimpleStreamOptions> & object)) {
					armWatchdog(); // any streamed event (content delta OR terminal) counts as progress
					armSlow(); // and pushes the slow-request status timer out
					if (ev.type === "error") {
						lastError = ev.error;
						continue; // hold
					}
					if (ev.type !== "start") clearWorking(); // real progress → drop the "waiting" hint
					out.push(ev as never);
					if (ev.type === "done") {
						out.end((ev as never).message ?? undefined);
						return;
					}
				}
			} finally {
				clearTimeout(watchdog);
				clearTimeout(slowTimer);
				clearWorking();
				signal?.removeEventListener("abort", onOuterAbort);
			}

			// Distinguish a genuine terminal error from a watchdog-killed stall.
			const isStall = timedOut;
			let err: AssistantMessage | undefined = lastError;
			if (isStall && !err) {
				err = {
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: `robust-provider: request made no progress within ${Math.round(attemptBudget / 1000)}s`,
				} as AssistantMessage;
			}

			// If we got a terminal 'done' through the loop we already returned. If the inner stream
			// ended with NEITHER done nor a held error event, treat it as a malformed — and retryable
			// — stream; emitting nothing here would leave `out` open forever and hang the consumer.
			if (!err) {
				err = {
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "robust-provider: stream ended without a terminal event",
				} as AssistantMessage;
			}

			lastTag = `${errorTag(err.errorMessage)} · ${host || "?"}`;
			const retryable = isStall || isBroadRetryable(err.stopReason, err.errorMessage, extra);
			const elapsed = Date.now() - started;
			const nowRemaining = deadline - Date.now();
			// Preserve the CALLER's abort semantics: pi (compaction, the agent loop) checks
			// stopReason === 'aborted' to cancel gracefully — never report a caller abort as an
			// error, and never retry one. (isStall masks it: a watchdog abort is our own, not the
			// caller's, and stays retryable.)
			const callerAborted = (signal?.aborted ?? false) && !isStall;
			const terminalReason = callerAborted || err.stopReason === "aborted" ? "aborted" : "error";
			const terminalErr =
				terminalReason === "aborted" && err.stopReason !== "aborted"
					? ({ ...err, stopReason: "aborted" } as AssistantMessage)
					: err;

			if (
				callerAborted ||
				!retryable ||
				attempt >= maxAttempts ||
				nowRemaining <= 0
			) {
				if (!callerAborted) {
					notify(
						`robust-provider: giving up (${err.stopReason ?? "?"}) [${lastTag}] — ${String(err.errorMessage ?? "").slice(0, 120)}`,
						"error",
					);
				}
				clearWorking();
				out.push({ type: "error", reason: terminalReason, error: terminalErr });
				out.end(terminalErr);
				return;
			}

			const delay = Math.min(cadenceMs, nowRemaining);
			notify(
				`robust-provider: retry ${attempt + 1} in ${(delay / 1000).toFixed(0)}s (${(elapsed / 1000).toFixed(0)}s elapsed, ~${(nowRemaining / 1000).toFixed(0)}s left) [${lastTag}] — ${String(err.errorMessage ?? "").slice(0, 80)}`,
			);
			// Between-attempts outage feedback: a down gateway spends ~99% of its wall-clock in
			// this cadence sleep (each attempt fails in under a second), so keep the working line
			// populated here instead of letting it sit blank for the whole 60s.
			emitWorking(
				`robust-provider: retrying LLM call (attempt ${attempt + 1}, next try in ${Math.max(1, Math.round(delay / 1000))}s, ~${Math.max(0, Math.ceil(nowRemaining / 60000))}min left) — [${lastTag}]`,
			);
			const ok = await sleep(delay);
			if (!ok || signal?.aborted || Date.now() > deadline) {
				const abortedByCaller = !!signal?.aborted;
				const finalReason = abortedByCaller ? "aborted" : terminalReason;
				const finalErr =
					abortedByCaller && terminalErr.stopReason !== "aborted"
						? ({ ...terminalErr, stopReason: "aborted" } as AssistantMessage)
						: terminalErr;
				clearWorking();
				out.push({ type: "error", reason: finalReason, error: finalErr });
				out.end(finalErr);
				return;
			}
			await runAttempt(attempt + 1, deadline);
		};

		void runAttempt(0, Date.now() + maxTotalMs);
		return out;
	};
}

/**
 * Determine the retry budget for a call.
 *
 * At the stream boundary there is NO reliable `metadata.interactive` tag: pi's
 * agent loop calls streamSimple(model, context, { ...createLoopConfig(), apiKey,
 * signal }) and createLoopConfig does NOT set `metadata` at all. So we instead
 * detect whether the caller is a real pi `Agent` loop by the presence of the
 * Agent-only config fields (sessionId + onPayload/onResponse + the follow-up/
 * steering pollers). The interactive main session *and* createAgentSession
 * subagents both run `new Agent(...)` and therefore carry these; OM-style
 * background workers (observer/reflector/dropper/contemplator) build a minimal
 * config (model, apiKey, headers, maxTokens, convertToLlm, toolExecution) with
 * none of them and so get the long worker budget.
 *
 * We treat an un-attributable caller as a worker (generous budget): if we can't
 * tell whether a human is waiting, prefer robustness over a loud stall.
 */
function isPiAgentLoop(options: StreamOptions | SimpleStreamOptions | undefined): boolean {
	if (!options) return false;
	const o = options as unknown as Record<string, unknown>;
	const hasAgentMarker =
		(typeof o.sessionId === "string" && (o.sessionId as string).length > 0) ||
		typeof o.onResponse === "function" ||
		typeof o.onPayload === "function" ||
		typeof o.getFollowUpMessages === "function" ||
		typeof o.getSteeringMessages === "function";
	return hasAgentMarker;
}
function budgetFor(
	options: StreamOptions | SimpleStreamOptions | undefined,
	opts: { mainMaxMs: number; workerMaxMs: number },
): number {
	return isPiAgentLoop(options) ? opts.mainMaxMs : opts.workerMaxMs;
}


export default function robustProvider(pi: ExtensionAPI) {
	const CADENCE = num(pi, "robust-provider-cadence-ms", "PI_ROBUST_PROVIDER_CADENCE_MS", 60000);
	const MAX_TOTAL = num(pi, "robust-provider-max-total-ms", "PI_ROBUST_PROVIDER_MAX_TOTAL_MS", 30 * 60 * 1000);
	const MAIN_MAX = num(pi, "robust-provider-main-max-ms", "PI_ROBUST_PROVIDER_MAIN_MAX_MS", 30 * 60 * 1000);
	const MAX_ATTEMPTS = num(pi, "robust-provider-max", "PI_ROBUST_PROVIDER_MAX", 1000);
	const STATUS_MS = num(pi, "robust-provider-status-ms", "PI_ROBUST_PROVIDER_STATUS_MS", 15000);
	const ATTEMPT_TIMEOUT = num(pi, "robust-provider-attempt-timeout-ms", "PI_ROBUST_PROVIDER_ATTEMPT_TIMEOUT_MS", 3 * 60 * 1000);
	const EXTRA = patterns(pi);
	// Register once at extension load. A single install is sufficient:
	// resetApiProviders() is only called from pi's manual /reload path (AgentSession.reload),
	// and /reload re-invokes the extension factory, which re-runs this install().
	// OM worker loops and normal session lifecycle never reset the compat registry.
	let installed = false;
	const notify = (msg: string, level: "info" | "warning" | "error" = "info") => {
		try {
			pi.notify?.(msg, level);
		} catch {
			/* ignore */
		}
	};

	// UI handle for status feedback, captured from the first session's event ctx — the
	// verified surface (official examples use ctx.ui; ExtensionAPI itself doesn't declare
	// `ui`). Guarded by ctx.hasUI: headless/print modes and OM background workers have no
	// interactive UI, so status silently no-ops there instead of throwing.
	let uiHook: { setWorkingMessage?: (m?: string) => void } | null = null;
	const setWorking = (m: string | undefined) => {
		try { uiHook?.setWorkingMessage?.(m); } catch { /* ignore */ }
	};
	pi.on("session_start", (_e: any, ctx: any) => {
		uiHook =
			ctx && ctx.hasUI && ctx.ui && typeof ctx.ui.setWorkingMessage === "function"
				? ctx.ui
				: null;
	});
	const install = () => {
		if (installed) return;
		const inner = getApiProvider(BASE_API);
		if (!inner || typeof inner.streamSimple !== "function" || typeof inner.stream !== "function") {
			// The builtin api we wrap isn't in the compat registry. This should never happen at
			// load (builtins register before any extension factory runs), but if it does, fail
			// LOUDLY: models.json may already point at "openai-completions-retry", so every
			// stream would otherwise die with a confusing 'No API provider registered' error.
			notify(`robust-provider: FATAL — builtin "${BASE_API}" not registered; cannot wrap. ` +
				`Any provider whose models.json api is "${API_ID}" will fail to stream. Check for a load-order conflict.`
				, "error");
			return;
		}
		const workerOpts = {
			cadenceMs: CADENCE,
			maxTotalMs: MAX_TOTAL,
			maxAttempts: MAX_ATTEMPTS,
			extra: EXTRA,
			notify,
			statusMs: STATUS_MS,
			attemptTimeoutMs: ATTEMPT_TIMEOUT,
			setWorking,
		};
		// The builtin `openai-completions` provider's stream/streamSimple are guard-wrapped (compat
		// registerApiProvider) to require model.api === BASE_API. But the model routing to our wrapper
		// carries api = API_ID (that's how it dispatched here). Normalize the model's api field back to
		// BASE_API when handing off to the inner builtin so its guard passes. The real request still uses
		// the model's baseUrl / apiKey / headers / id (all preserved by the clone) — only the api tag
		// changes, which gates dispatch only.
		const callAsBuiltin = (fn: StreamFn): StreamFn =>
			(model, context, options) => fn({ ...model, api: BASE_API as never }, context, options);
		const streamFn: StreamFn = (model, context, options) => {
			const budget = budgetFor(options, { mainMaxMs: MAIN_MAX, workerMaxMs: MAX_TOTAL });
			return withRobustStream(callAsBuiltin(inner.stream), { ...workerOpts, maxTotalMs: budget })(
				model, context, options,
			);
		};
		const streamSimpleFn: StreamFn = (model, context, options) => {
			const budget = budgetFor(options, { mainMaxMs: MAIN_MAX, workerMaxMs: MAX_TOTAL });
			return withRobustStream(callAsBuiltin(inner.streamSimple), { ...workerOpts, maxTotalMs: budget })(
				model, context, options,
			);
		};
		try {
			unregisterApiProviders("pi-robust-provider");
			registerApiProvider(
				{
					api: API_ID as never,
					stream: streamFn as StreamFunction as never,
					streamSimple: streamSimpleFn as never,
				},
				"pi-robust-provider",
			);
		} catch (e) {
			// Never crash the extension loader / swallow registration errors silently — tell the user.
			notify(`robust-provider: FAILED to register "${API_ID}" — ${e instanceof Error ? e.message : String(e)}`, "error");
			return;
		}
		installed = true;
		notify(`robust-provider: registered "${API_ID}" (wraps ${BASE_API})`);
	};
	install();
}
