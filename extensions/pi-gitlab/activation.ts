/**
 * Staged activation policy (plan §2). Pure — index.ts applies the results
 * via pi.getActiveTools()/setActiveTools().
 */

export const ALWAYS_ON_TOOL = "gitlab_fetch";
export const GATED_TOOLS = ["gitlab_put", "gitlab_watch"] as const;

/** session_start: restrict to everything except the gated tools. */
export function restrictedToolSet(current: string[]): string[] {
	return current.filter((t) => !(GATED_TOOLS as readonly string[]).includes(t));
}

/**
 * Unlock after first successful fetch (or when watches re-arm).
 * Returns null when already unlocked (no setActiveTools call needed).
 */
export function unlockedToolSet(current: string[]): string[] | null {
	if ((GATED_TOOLS as readonly string[]).every((g) => current.includes(g))) return null;
	return [...new Set([...current, ...GATED_TOOLS])];
}
