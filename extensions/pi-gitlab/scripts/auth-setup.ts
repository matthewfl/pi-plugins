#!/usr/bin/env node
/**
 * Standalone auth setup (mirrors /gitlab-auth, for use outside pi):
 *   node scripts/auth-setup.ts https://gitlab.example.com
 * Prompts for a PAT (masked), verifies via GET /api/v4/user, writes
 * ~/.pi/agent/gitlab/config/auth.json with 0600. On an unreachable host it
 * stores the token unverified (warn-but-store, like /gitlab-auth).
 */
import * as readline from "node:readline";
import { GitLabClient, GitLabError } from "../client.ts";
import { saveAuth } from "../auth.ts";

const baseUrl = process.argv[2]?.trim();
if (!baseUrl || !/^https?:\/\/[^/]+$/.test(baseUrl)) {
	console.error("usage: node scripts/auth-setup.ts https://gitlab.example.com");
	process.exit(1);
}

console.log(`\nCreate a Personal Access Token with the 'api' scope at:`);
console.log(`  ${baseUrl}/-/user_settings/personal_access_tokens  (older GitLab: /-/profile/personal_access_tokens)\n`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
// mask echoed input
const origWrite = (rl as any)._writeToOutput?.bind(rl);
if (origWrite) {
	(rl as any)._writeToOutput = (s: string) => {
		if (s.includes("\n")) origWrite(s);
		else (rl as any).output.write("*");
	};
}

const token: string = await new Promise((resolve) => {
	rl.question(`Paste token for ${baseUrl}: `, (answer) => resolve(answer.trim()));
});
rl.close();
console.log();

if (!token) {
	console.error("no token entered, aborting");
	process.exit(1);
}

const client = new GitLabClient(baseUrl, token, {});
try {
	const u = (await Promise.race([
		client.getCurrentUser(),
		new Promise((_, rej) => setTimeout(() => rej(new Error("verification timed out after 8s")), 8000)),
	])) as { username: string };
	await saveAuth(baseUrl, { token, username: u.username });
	console.log(`✓ authenticated as @${u.username} on ${baseUrl} (token stored in ~/.pi/agent/gitlab/config/auth.json)`);
} catch (e) {
	if (e instanceof GitLabError && e.status > 0) {
		console.error(`✗ token rejected: ${e.message}`);
		process.exit(1);
	}
	await saveAuth(baseUrl, { token });
	console.warn(`⚠ couldn't reach ${baseUrl} (${e instanceof Error ? e.message : e}) — stored anyway; verified lazily on first use`);
}
