/**
 * auth.json + config.json storage (plan §3). File-only auth — no env vars.
 */

import { promises as fs } from "node:fs";
import { authPath, configDir, configPath, dataRoot } from "./paths.ts";

export interface AuthEntry {
	token: string;
	/** token user's GitLab username — drives from_operator attribution */
	username?: string;
}
export type AuthFile = Record<string, AuthEntry>;

export interface PluginConfig {
	confirmBeforePost: boolean;
	signatureHeader: string;
	botUsernames: string[];
	watchIntervalSeconds: number;
	/**
	 * RegExps matched against the trimmed staged comment body; a match posts
	 * the comment WITHOUT the signature header ("unsigned triggers whitelist",
	 * for bot trigger phrases like `/merge` or `ci test`). Global list…
	 */
	bypassSignaturePatterns: string[];
	/** …plus optional per-server additions keyed by baseUrl (same keys as auth.json). */
	servers: Record<string, { bypassSignaturePatterns: string[] }>;
}

export const DEFAULT_CONFIG: PluginConfig = {
	confirmBeforePost: true,
	signatureHeader: "_🤖 Automatically written by pi-gitlab (AI agent). Review before acting._",
	botUsernames: [],
	watchIntervalSeconds: 120,
	bypassSignaturePatterns: [],
	servers: {},
};

async function readJsonFile(file: string): Promise<unknown | null> {
	let text: string;
	try {
		text = await fs.readFile(file, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
	try {
		return JSON.parse(text);
	} catch {
		return null; // corrupt file → treat as absent; callers surface actionable errors
	}
}

export async function loadAuthFile(root: string = dataRoot()): Promise<AuthFile> {
	const raw = await readJsonFile(authPath(root));
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: AuthFile = {};
	for (const [host, v] of Object.entries(raw as Record<string, unknown>)) {
		if (v && typeof v === "object" && typeof (v as AuthEntry).token === "string") {
			out[host] = { token: (v as AuthEntry).token, username: (v as AuthEntry).username };
		}
	}
	return out;
}

export async function loadAuth(
	baseUrl: string,
	root: string = dataRoot(),
): Promise<AuthEntry | null> {
	const all = await loadAuthFile(root);
	return all[baseUrl] ?? null;
}

export async function saveAuth(
	baseUrl: string,
	entry: AuthEntry,
	root: string = dataRoot(),
): Promise<void> {
	const all = await loadAuthFile(root);
	all[baseUrl] = entry;
	await fs.mkdir(configDir(root), { recursive: true });
	await fs.writeFile(authPath(root), JSON.stringify(all, null, 2) + "\n", {
		mode: 0o600,
	});
	// Ensure mode even when overwriting an existing file with looser perms.
	await fs.chmod(authPath(root), 0o600);
}

export async function loadConfig(root: string = dataRoot()): Promise<PluginConfig> {
	const raw = await readJsonFile(configPath(root));
	const cfg = { ...DEFAULT_CONFIG };
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		const o = raw as Record<string, unknown>;
		if (typeof o.confirmBeforePost === "boolean") cfg.confirmBeforePost = o.confirmBeforePost;
		if (typeof o.signatureHeader === "string" && o.signatureHeader.trim())
			cfg.signatureHeader = o.signatureHeader.trimEnd();
		if (Array.isArray(o.botUsernames))
			cfg.botUsernames = o.botUsernames.filter((u): u is string => typeof u === "string");
		if (typeof o.watchIntervalSeconds === "number" && o.watchIntervalSeconds >= 30)
			cfg.watchIntervalSeconds = Math.floor(o.watchIntervalSeconds);
		if (Array.isArray(o.bypassSignaturePatterns))
			cfg.bypassSignaturePatterns = o.bypassSignaturePatterns.filter(
				(p): p is string => typeof p === "string" && p.length > 0,
			);
		if (o.servers && typeof o.servers === "object" && !Array.isArray(o.servers)) {
			for (const [baseUrl, v] of Object.entries(o.servers as Record<string, unknown>)) {
				if (v && typeof v === "object" && Array.isArray((v as { bypassSignaturePatterns?: unknown }).bypassSignaturePatterns)) {
					const patterns = (
						(v as { bypassSignaturePatterns: unknown[] }).bypassSignaturePatterns
					).filter((p): p is string => typeof p === "string" && p.length > 0);
					cfg.servers[baseUrl] = { bypassSignaturePatterns: patterns };
				}
			}
		}
	}
	return cfg;
}

/**
 * Compiled effective whitelist for one instance: global ∪ per-server (deduped,
 * insertion-ordered). Throws with a precise message on an invalid regexp so the
 * user hears about their config, not a stack trace.
 */
export function effectiveBypassPatterns(cfg: PluginConfig, baseUrl: string): RegExp[] {
	const all = [
		...cfg.bypassSignaturePatterns,
		...(cfg.servers[baseUrl]?.bypassSignaturePatterns ?? []),
	].filter((p, i, a) => a.indexOf(p) === i);
	return all.map((p) => {
		try {
			return new RegExp(p);
		} catch (e) {
			throw new Error(
				`invalid bypassSignaturePatterns entry ${JSON.stringify(p)} in config.json: ${(e as Error).message}`,
			);
		}
	});
}

/** True when any whitelist pattern matches the staged body (trimmed, whole body). */
export function bypassesSignature(body: string, patterns: RegExp[]): boolean {
	const trimmed = body.trim();
	return patterns.some((re) => re.test(trimmed));
}

/**
 * Full-body variants: used by watch notification silencing so only comments
 * whose ENTIRE trimmed body matches a pattern count as "our unsigned post".
 * A prose comment that merely MENTIONS a trigger ("check why the /test run
 * failed") still notifies — silencing only needs to cover pi's own verbatim
 * trigger posts (id recording is the primary signal anyway).
 */
export function fullBodyBypassMatchers(patterns: RegExp[]): RegExp[] {
	return patterns.map((re) => {
		const flags = re.flags.replace(/[gy]/g, "");
		return new RegExp(`^(?:${re.source})$`, flags);
	});
}

/** True when `username` looks like a bot/service account (plan §4.2). */
export function looksLikeBot(username: string, extra: string[] = []): boolean {
	const u = username.toLowerCase();
	if (extra.some((b) => u === b.toLowerCase())) return true;
	return /(^|[-_])bot([-_]|$)|bot$|_bot_|^ci[-_]|[-_]ci$|pipeline/.test(u);
}

/** Tool-callable error when no token is stored for a host (plan §3). */
export function noAuthError(baseUrl: string): string {
	return (
		`no GitLab token stored for ${baseUrl}.\n` +
		`Ask the operator to run: /gitlab-auth ${baseUrl}\n` +
		`(creates a Personal Access Token with the "api" scope and stores it under ~/.pi/agent/gitlab/config/auth.json)`
	);
}
