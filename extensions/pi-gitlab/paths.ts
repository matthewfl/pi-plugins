/**
 * Data layout on disk (plan §1):
 *
 *   <agentDir>/gitlab/          (agentDir = PI_CODING_AGENT_DIR or ~/.pi/agent)
 *   ├── config/{auth.json, config.json}
 *   ├── mr|issue/<slug>.gitlab.md (+ .diff)
 *   └── .store/<slug>/{base, prev, state.json}
 *
 * Root precedence mirrors pi itself (getAgentDir): PI_GITLAB_DIR overrides
 * everything (tests, exotic setups); otherwise the pi agent dir — i.e.
 * $PI_CODING_AGENT_DIR when pi runs with a custom agent dir, else ~/.pi/agent.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { GitLabItemRef } from "./url.ts";
import { slugFor } from "./url.ts";

/** The pi agent dir — same resolution as pi's getAgentDir():
 * $PI_CODING_AGENT_DIR (if set and non-empty) else ~/.pi/agent. */
export function agentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env?.trim()) return env.trim();
	return path.join(os.homedir(), ".pi", "agent");
}

export function dataRoot(): string {
	return process.env.PI_GITLAB_DIR?.trim() || path.join(agentDir(), "gitlab");
}

export function configDir(root: string = dataRoot()): string {
	return path.join(root, "config");
}
export function authPath(root: string = dataRoot()): string {
	return path.join(configDir(root), "auth.json");
}
export function configPath(root: string = dataRoot()): string {
	return path.join(configDir(root), "config.json");
}

export function itemFilePath(ref: GitLabItemRef, root: string = dataRoot()): string {
	return path.join(root, ref.kind === "mr" ? "mr" : "issue", `${slugFor(ref)}.gitlab.md`);
}
export function diffPathFor(itemFile: string): string {
	return `${itemFile}.diff`;
}

export function storeDir(ref: GitLabItemRef, root: string = dataRoot()): string {
	return path.join(root, ".store", slugFor(ref));
}
export function basePath(ref: GitLabItemRef, root: string = dataRoot()): string {
	return path.join(storeDir(ref, root), "base");
}
export function prevPath(ref: GitLabItemRef, root: string = dataRoot()): string {
	return path.join(storeDir(ref, root), "prev");
}
export function statePath(ref: GitLabItemRef, root: string = dataRoot()): string {
	return path.join(storeDir(ref, root), "state.json");
}

/** state.json sidecar (plan §5). */
export interface ItemState {
	fetchedAt: string;
	serverUpdatedAt?: string;
	sourceUrl: string;
	headSha?: string;
	diffRefs?: { base_sha: string; start_sha: string; head_sha: string };
	/** note ids posted by the extension — persists via_pi attribution for
	 * unsigned (whitelist) posts that carry no signature header. */
	viaPiNoteIds?: number[];
}
