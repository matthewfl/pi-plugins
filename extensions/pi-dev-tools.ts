/**
 * pi.dev development helpers.
 *
 * Provides an intentionally powerful, local-only scratchpad for inspecting the
 * live pi extension context, plus an agent-callable reload flow. The evaluator
 * is not a security sandbox: extensions already run with the user's privileges.
 */
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import * as util from "node:util";
import * as vm from "node:vm";

const RESUME_ENTRY = "pi-dev-tools:resume";
const ACK_ENTRY = "pi-dev-tools:resume-ack";
const MAX_OUTPUT = 45_000;
const EXTENSION_REVISION = "eval-timeout-v10";
// Cap how long pi_dev_eval waits on a returned promise before yielding control
// back to the LLM. Async work (e.g. launching a reviewer) keeps running in the
// background; the eval just stops blocking on it after this window.
const EVAL_ASYNC_TIMEOUT_MS = 5_000;
type ResumeEntry = { id: string; message: string; stagedPath?: string };
type ReloadState = {
	pendingId?: string;
	completedId?: string;
	wake?: () => void;
	timeout?: ReturnType<typeof setTimeout>;
	inFlight?: boolean;
};
const RELOAD_TIMEOUT_MS = 5 * 60_000;

const RELOAD_STATE = Symbol.for("pi-dev-tools.reload-state");
const AGENT_RELOAD_REQUEST = Symbol.for("pi-dev-tools.agent-reload-request");

function getReloadState(): ReloadState {
	const global = globalThis as typeof globalThis & {
		[RELOAD_STATE]?: ReloadState;
	};
	return (global[RELOAD_STATE] ??= {});
}

type ReloadableToolContext = ExtensionContext & {
	reload?: () => Promise<void>;
};

interface ExtensionRunnerPrototype {
	createContext: (this: ExtensionRunnerInstance) => Record<string, unknown>;
}

interface ExtensionRunnerInstance {
	assertActive?: () => void;
	reloadHandler?: () => Promise<unknown>;
}

const TOOL_RELOAD_PATCH = Symbol.for(
	"pi-dev-tools.tool-context-reload-patch-v2",
);

async function installToolContextReloadPatch(): Promise<boolean> {
	const state = globalThis as typeof globalThis & {
		[TOOL_RELOAD_PATCH]?: boolean;
	};
	if (state[TOOL_RELOAD_PATCH]) return true;

	try {
		const packageEntryUrl = import.meta.resolve(
			"@earendil-works/pi-coding-agent",
		);
		const packageDistDir = path.dirname(url.fileURLToPath(packageEntryUrl));
		const runnerUrl = url.pathToFileURL(
			path.join(packageDistDir, "core/extensions/runner.js"),
		).href;
		const runnerModule = (await import(runnerUrl)) as {
			ExtensionRunner?: { prototype?: ExtensionRunnerPrototype };
		};
		const prototype = runnerModule.ExtensionRunner?.prototype;
		if (!prototype || typeof prototype.createContext !== "function")
			return false;

		const interactiveUrl = url.pathToFileURL(
			path.join(packageDistDir, "modes/interactive/interactive-mode.js"),
		).href;
		const interactiveModule = (await import(interactiveUrl)) as {
			InteractiveMode?: {
				prototype?: {
					handleReloadCommand?: (...args: unknown[]) => Promise<unknown>;
				};
			};
		};
		const interactivePrototype = interactiveModule.InteractiveMode?.prototype;
		const originalHandleReload = interactivePrototype?.handleReloadCommand;
		if (interactivePrototype && originalHandleReload) {
			interactivePrototype.handleReloadCommand = async function (...args) {
				const global = globalThis as typeof globalThis & {
					[AGENT_RELOAD_REQUEST]?: boolean;
				};
				const session = (this as { session?: {
					isStreaming?: boolean;
					isCompacting?: boolean;
				} }).session;
				if (
					global[AGENT_RELOAD_REQUEST] &&
					(session?.isStreaming || session?.isCompacting)
				) {
					return false;
				}
				return originalHandleReload.apply(this, args);
			};
		}

		const originalCreateContext = prototype.createContext;
		prototype.createContext = function patchedCreateContext(
			this: ExtensionRunnerInstance,
		) {
			const context = originalCreateContext.call(this) as ReloadableToolContext;
			if (typeof context.reload !== "function") {
				context.reload = async () => {
					this.assertActive?.();
					if (typeof this.reloadHandler !== "function") {
						throw new Error("Pi reload handler is unavailable");
					}
					await this.reloadHandler();
				};
			}
			return context;
		};

		state[TOOL_RELOAD_PATCH] = true;
		return true;
	} catch {
		return false;
	}
}

type EvalParams = {
	expression: string;
	mode?: "evaluate" | "inspect";
	depth?: number;
	keys?: number;
};

function text(value: unknown): string {
	if (typeof value === "string") return value;
	return util.inspect(value, { depth: 6, colors: false, maxArrayLength: 100 });
}

function inspectValue(
	value: unknown,
	depth: number,
	keys: number,
	seen = new WeakSet<object>(),
): unknown {
	if (
		value === null ||
		(typeof value !== "object" && typeof value !== "function")
	)
		return value;
	if (seen.has(value)) return "[Circular]";
	if (depth <= 0) return `[${typeof value}]`;
	seen.add(value);

	const result: Record<string, unknown> = {
		type: typeof value,
		constructor: (value as { constructor?: { name?: string } }).constructor
			?.name,
		prototype: Object.getPrototypeOf(value)?.constructor?.name ?? null,
		keys: Reflect.ownKeys(value).slice(0, keys).map(String),
		properties: {},
	};
	const properties = result.properties as Record<string, unknown>;

	for (const key of Reflect.ownKeys(value).slice(0, keys)) {
		const name = String(key);
		try {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor) continue;
			if ("value" in descriptor) {
				properties[name] = inspectValue(
					descriptor.value,
					depth - 1,
					keys,
					seen,
				);
			} else {
				properties[name] = {
					getter: Boolean(descriptor.get),
					setter: Boolean(descriptor.set),
					note: "getter not invoked",
				};
			}
		} catch (error) {
			properties[name] = `[unreadable: ${text(error)}]`;
		}
	}
	return result;
}

function makeScope(pi: ExtensionAPI, ctx: ExtensionContext) {
	const session = ctx.sessionManager;
	return {
		// pi extension API and live context
		pi,
		extensionRevision: EXTENSION_REVISION,
		ctx,
		session,
		sessionManager: session,
		model: ctx.model,
		modelRegistry: ctx.modelRegistry,
		thinkingLevel: ctx.thinkingLevel,
		scopedModels: ctx.scopedModels,
		cwd: ctx.cwd,
		signal: ctx.signal,
		activeTools: pi.getActiveTools(),
		allTools: pi.getAllTools(),
		commands: pi.getCommands(),
		systemPrompt: ctx.getSystemPrompt(),
		// Common runtime values/modules
		process,
		env: process.env,
		fs,
		os,
		path,
		url,
		util,
		vm,
		Type,
		console,
		// Web-standard timers + abort, handy in the VM for async work.
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		AbortController,
		// Module loading: dynamic ESM import and a CJS require rooted at this
		// extension's location. importModule returns the module namespace; call
		// await importModule(url.pathToFileURL(absPath).href) for local files.
		importModule: (specifier: string): Promise<unknown> =>
			import(specifier) as Promise<unknown>,
		require: createRequire(import.meta.url),
		// Handy constructors
		JSON,
		Math,
		Date,
		RegExp,
		Map,
		Set,
	};
}

async function evaluate(
	expression: string,
	scope: Record<string, unknown>,
): Promise<unknown> {
	// vm keeps the expression separate from the extension's lexical scope. The
	// returned value (which may itself be a promise) is handed to the caller's
	// race rather than awaited there, so a long-running async expression does
	// not block the tool call.
	return vm.runInNewContext(`(${expression})`, scope, {
		timeout: 2_000,
		displayErrors: true,
	});
}

function result(value: unknown, details: Record<string, unknown> = {}) {
	const output = text(value);
	return {
		content: [
			{
				type: "text" as const,
				text:
					output.length > MAX_OUTPUT
						? `${output.slice(0, MAX_OUTPUT)}\n[truncated]`
						: output,
			},
		],
		details,
	};
}

/**
 * Settle a possibly-promise eval result within a bounded window using
 * Promise.race. If the promise does not win the race within `ms`, return a
 * timeout marker and let the underlying async work keep running fire-and-forget
 * so the LLM never blocks for long.
 */
async function resolveWithTimeout(
	value: unknown,
	ms: number,
): Promise<{ value: unknown; timedOut?: boolean }> {
	if (!value || typeof (value as { then?: unknown }).then !== "function") {
		return { value };
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<{ value: undefined; timedOut: true }>((resolve) => {
		timer = setTimeout(() => resolve({ value: undefined, timedOut: true }), ms);
	});
	const settled = await Promise.race([
		Promise.resolve(value).then(
			(v) => ({ value: v }),
			(e) => ({ value: { __pi_eval_error__: text(e) } }),
		),
		timeout,
	]);
	if (timer) clearTimeout(timer);
	if (settled.timedOut) {
		// Swallow late rejections from the still-running background promise.
		Promise.resolve(value).catch(() => {});
	}
	return settled;
}

function scheduleDirectReload(
	pi: ExtensionAPI,
	ctx: ReloadableToolContext,
	message: string,
	stagedPath?: string,
): void {
	const reload = ctx.reload;
	if (typeof reload !== "function") {
		throw new Error("Pi reload handler is unavailable in tool context");
	}

	const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const state = getReloadState();
	state.pendingId = id;
	state.completedId = undefined;
	if (message || stagedPath) {
		pi.appendEntry(RESUME_ENTRY, { id, message, stagedPath } satisfies ResumeEntry);
	}

	const attempt = async () => {
		if (state.completedId === id || state.inFlight) return;
		// Poll only the cheap idle check while Pi is busy. We never invoke the
		// reload handler in this state, so this cannot produce Pi warnings.
		if (ctx.isIdle?.() === false) {
			setTimeout(() => void attempt(), 1_000);
			return;
		}

		state.inFlight = true;
		const global = globalThis as typeof globalThis & {
			[AGENT_RELOAD_REQUEST]?: boolean;
		};
		try {
			global[AGENT_RELOAD_REQUEST] = true;
			const reloadResult = await reload();
			if (reloadResult === false && state.completedId !== id) {
				setTimeout(() => void attempt(), 1_000);
			}
		} catch (error: unknown) {
			state.wake = undefined;
			ctx.ui?.notify(`Pi reload failed: ${text(error)}`, "error");
		} finally {
			global[AGENT_RELOAD_REQUEST] = false;
			state.inFlight = false;
		}
	};

	state.wake = () => void attempt();
	state.timeout = setTimeout(() => {
		if (state.completedId !== id) {
			state.wake = undefined;
			ctx.ui?.notify("Timed out waiting for Pi to reload", "error");
		}
	}, RELOAD_TIMEOUT_MS);
	setTimeout(() => void attempt(), 0);
}

export default async function piDevTools(pi: ExtensionAPI) {
	await installToolContextReloadPatch();

	const evalParams = Type.Object({
		expression: Type.String({
			description:
				"A JavaScript expression evaluated against the live pi scope",
		}),
		mode: Type.Optional(
			Type.Union([Type.Literal("evaluate"), Type.Literal("inspect")]),
		),
		depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
		keys: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
	});

	pi.registerTool({
		name: "pi_dev_eval",
		label: "pi Dev Eval",
		description:
			"Evaluate a JavaScript expression against the live pi extension API/context, or inspect its object fields. This is intentionally powerful and not a security sandbox.",
		promptSnippet:
			"Evaluate or inspect JavaScript against the live pi extension runtime",
		parameters: evalParams,
		async execute(_id, params: EvalParams, _signal, _update, ctx) {
			try {
				const raw = evaluate(params.expression, makeScope(pi, ctx));
				const settled = await resolveWithTimeout(raw, EVAL_ASYNC_TIMEOUT_MS);
				if (settled.timedOut) {
					return result(
						`[pi_dev_eval timed out after ${EVAL_ASYNC_TIMEOUT_MS}ms] The expression returned a promise that did not settle in time. It is still running in the background and is no longer awaited, so this call does not block.`,
					{ mode: params.mode ?? "evaluate", timedOut: true, type: "promise" },
				);
			}
			const value = settled.value;
			if (params.mode === "inspect") {
				return result(
					inspectValue(value, params.depth ?? 3, params.keys ?? 80),
					{ mode: "inspect" },
				);
			}
			return result(value, { mode: "evaluate", type: typeof value });
		} catch (error) {
			throw new Error(`pi_dev_eval failed: ${text(error)}`);
		}
		},
	});
	pi.registerTool({
		name: "pi_dev_discover",
		label: "pi Dev Discover",
		description:
			"Search the tools and commands currently registered in Pi. Use this to discover capabilities provided by installed extensions and packages.",
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({
					description: "Case-insensitive search text; omit to list everything",
				}),
			),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
		}),
		async execute(_id, params) {
			const query = params.query?.trim().toLowerCase() ?? "";
			const limit = params.limit ?? 50;
			const matches = (value: unknown) =>
				!query || text(value).toLowerCase().includes(query);
			const describe = (value: unknown) =>
				text(value)
					.split(/\n\s*\n|\n/)[0]
					.slice(0, 240);
			const source = (value: unknown) => {
				if (!value || typeof value !== "object") return value;
				const info = value as Record<string, unknown>;
				return { source: info.source, path: info.path };
			};
			const tools = pi
				.getAllTools()
				.filter((tool) =>
					matches({
						name: tool.name,
						description: tool.description,
						sourceInfo: tool.sourceInfo,
					}),
				)
				.slice(0, limit)
				.map((tool) => ({
					name: tool.name,
					description: describe(tool.description),
					source: source(tool.sourceInfo),
				}));
			const commands = pi
				.getCommands()
				.filter((command) => matches(command))
				.slice(0, limit)
				.map((command) => ({
					name: command.name,
					description: describe(command.description),
					source: source(command.sourceInfo),
				}));
			return result(
				{ query, tools, commands },
				{
					toolCount: tools.length,
					commandCount: commands.length,
				},
			);
		},
	});
	pi.registerTool({
		name: "pi_dev_compact",
		label: "pi Dev Compact",
		description:
			"Manually trigger context compaction. Optionally provide instructions for what the compaction summary should preserve.",
		parameters: Type.Object({
			customInstructions: Type.Optional(
				Type.String({
					description: "Optional instructions for the compaction summary",
				}),
			),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			ctx.compact({
				customInstructions: params.customInstructions?.trim() || undefined,
				onComplete: () =>
					ctx.ui.notify("Pi context compaction completed", "info"),
				onError: (error) =>
					ctx.ui.notify(
						`Pi context compaction failed: ${text(error)}`,
						"error",
					),
			});
			return result("Pi context compaction started.", { queued: true });
		},
	});

	// Wake a pending reload from lifecycle events instead of repeatedly calling
	// the interactive reload handler while it is blocked by compaction.
	pi.on("agent_end", () => getReloadState().wake?.());
	pi.on("turn_end", () => getReloadState().wake?.());
	pi.on("session_compact", () => getReloadState().wake?.());

	pi.registerTool({
		name: "pi_dev_reload",
		label: "pi Dev Reload",
		description:
			"Reload pi extensions. Optionally provide an extension file path to stage like -e, and a message to resume the conversation after reload.",
		parameters: Type.Object({
			extensionPath: Type.Optional(
				Type.String({
					description:
						"Path to a local .ts/.js extension to stage for this reload",
				}),
			),
			resumeMessage: Type.Optional(
				Type.String({
					description:
						"User message to send after the new extension runtime starts",
				}),
			),
		}),
		async execute(
			_id,
			params: { extensionPath?: string; resumeMessage?: string },
			_signal,
			_update,
			ctx,
		) {
			const runtimeCtx = ctx as ReloadableToolContext;
			let stagedPath: string | undefined;
			if (params.extensionPath) {
				const sourcePath = path.resolve(ctx.cwd, params.extensionPath);
				if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
					return result(`Extension file not found: ${sourcePath}`, {
						queued: false,
					});
				}
				stagedPath = path.join(
					os.tmpdir(),
					`pi-dev-e-${process.pid}-${Date.now()}.ts`,
				);
				fs.copyFileSync(sourcePath, stagedPath);
				const globalPath = path.join(
					process.env.HOME ?? os.homedir(),
					".pi",
					"agent",
					"extensions",
					path.basename(stagedPath),
				);
				fs.copyFileSync(stagedPath, globalPath);
				stagedPath = globalPath;
			}

			if (typeof runtimeCtx.reload !== "function") {
				return result(
					"Direct tool-context reload is unavailable; reload the extension with /reload manually.",
					{ queued: false, reason: "reload-patch-unavailable" },
				);
			}

			scheduleDirectReload(
				pi,
				runtimeCtx,
				params.resumeMessage?.trim() ?? "",
				stagedPath,
			);
			return result(
				"Pi reload queued after the current response; the continuation message will be sent after reload.",
				{ queued: true },
			);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const pending = entries.reduceRight(
			(found, entry) =>
				found ??
				(entry.type === "custom" && entry.customType === RESUME_ENTRY
					? (entry.data as ResumeEntry)
					: undefined),
			undefined as ResumeEntry | undefined,
		);
		const acknowledged = entries.reduceRight(
			(found, entry) =>
				found ??
				(entry.type === "custom" && entry.customType === ACK_ENTRY
					? (entry.data as { id?: string })
					: undefined),
			undefined as { id?: string } | undefined,
		);
		if (!pending || pending.id === acknowledged?.id) return;

		const reloadState = getReloadState();
		if (reloadState.pendingId === pending.id) {
			reloadState.completedId = pending.id;
			reloadState.wake = undefined;
			if (reloadState.timeout) clearTimeout(reloadState.timeout);
		}
		pi.appendEntry(ACK_ENTRY, { id: pending.id });
		if (pending.stagedPath) {
			try {
				fs.unlinkSync(pending.stagedPath);
			} catch {
				/* best effort cleanup */
			}
		}
		if (pending.message) pi.sendUserMessage(pending.message);
	});
}
