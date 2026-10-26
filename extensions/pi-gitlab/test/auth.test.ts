import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	bypassesSignature,
	effectiveBypassPatterns,
	fullBodyBypassMatchers,
	loadAuth,
	loadAuthFile,
	loadConfig,
	looksLikeBot,
	saveAuth,
} from "../auth.ts";
import { authPath, itemFilePath, storeDir } from "../paths.ts";
import { parseGitLabUrl } from "../url.ts";

async function tmpRoot(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "pi-gitlab-auth-test-"));
}

test("auth round-trip: load, save (0600), reload", async () => {
	const root = await tmpRoot();
	assert.equal(await loadAuth("https://gitlab.com", root), null);
	await saveAuth("https://gitlab.com", { token: "glpat-abc", username: "matthew" }, root);
	const entry = await loadAuth("https://gitlab.com", root);
	assert.equal(entry?.token, "glpat-abc");
	assert.equal(entry?.username, "matthew");
	const mode = (await fs.stat(authPath(root))).mode & 0o777;
	assert.equal(mode, 0o600, "auth.json must be 0600");
	// merge: saving a second host keeps the first
	await saveAuth("https://corp.example", { token: "glpat-xyz" }, root);
	const all = await loadAuthFile(root);
	assert.deepEqual(Object.keys(all).sort(), ["https://corp.example", "https://gitlab.com"]);
});

test("corrupt auth.json treated as empty", async () => {
	const root = await tmpRoot();
	await fs.mkdir(path.dirname(authPath(root)), { recursive: true });
	await fs.writeFile(authPath(root), "not json{", "utf8");
	assert.deepEqual(await loadAuthFile(root), {});
});

test("config defaults + overrides", async () => {
	const root = await tmpRoot();
	const dflt = await loadConfig(root);
	assert.equal(dflt.confirmBeforePost, true);
	assert.equal(dflt.watchIntervalSeconds, 120);
	assert.match(dflt.signatureHeader, /pi-gitlab/);
	await fs.mkdir(path.dirname(authPath(root)), { recursive: true });
	await fs.writeFile(
		path.join(root, "config", "config.json"),
		JSON.stringify({ confirmBeforePost: false, watchIntervalSeconds: 45, junk: 1 }),
	);
	const cfg = await loadConfig(root);
	assert.equal(cfg.confirmBeforePost, false);
	assert.equal(cfg.watchIntervalSeconds, 45);
});

test("bot heuristics", () => {
	assert.equal(looksLikeBot("deploy-bot", []), true);
	assert.equal(looksLikeBot("ci-runner", []), true);
	assert.equal(looksLikeBot("alice", []), false);
	assert.equal(looksLikeBot("alice", ["alice"]), true);
});

test("path layout follows plan §1", () => {
	const ref = parseGitLabUrl("https://gitlab.com/g/p/-/merge_requests/42");
	if (!ref.ok) throw new Error(ref.error);
	const root = "/root/gitlab";
	assert.equal(itemFilePath(ref.ref, root), "/root/gitlab/mr/gitlab.com__g%2Fp__mr-42.gitlab.md");
	assert.equal(storeDir(ref.ref, root), "/root/gitlab/.store/gitlab.com__g%2Fp__mr-42");
});

test("whitelist config: global ∪ per-server, dedup, invalid regexp errors", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gitlab-wl-"));
	await fs.mkdir(path.join(root, "config"), { recursive: true });
	await fs.writeFile(
		path.join(root, "config/config.json"),
		JSON.stringify({
			bypassSignaturePatterns: ["^/merge$", "^\\/test$"],
			servers: {
				"https://gl.h": { bypassSignaturePatterns: ["^ci test\\b", "^/merge$"] },
			},
		}),
	);
	const cfg = await loadConfig(root);
	const pats = effectiveBypassPatterns(cfg, "https://gl.h");
	assert.equal(pats.length, 3, "global ∪ per-server deduped");
	assert.ok(bypassesSignature("ci test please", pats));
	assert.ok(bypassesSignature("/test", pats));
	assert.ok(bypassesSignature("  /merge\n", pats), "trimmed body matches");
	assert.ok(!bypassesSignature("please ci test", pats));
	assert.ok(!bypassesSignature("normal review comment", pats));
	// other host gets only global
	assert.equal(effectiveBypassPatterns(cfg, "https://other.h").length, 2);
});

test("whitelist config: invalid regexp named in error", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gitlab-wl-"));
	await fs.mkdir(path.join(root, "config"), { recursive: true });
	await fs.writeFile(path.join(root, "config/config.json"), JSON.stringify({ bypassSignaturePatterns: ["([unbalanced"] }));
	const cfg = await loadConfig(root);
	assert.throws(() => effectiveBypassPatterns(cfg, "https://x"), /invalid bypassSignaturePatterns entry "\(\[unbalanced"/);
});

test("fullBodyBypassMatchers: exact body only, g/y flags stripped", () => {
	const [m] = fullBodyBypassMatchers([/ci test/gi]);
	assert.ok(m.test("CI TEST"), "flags preserved (i), g stripped (no lastIndex statefulness)");
	assert.ok(m.test("ci test"));
	assert.ok(!m.test("ci test please"), "trailing prose breaks the match");
	assert.ok(!m.test("run ci test"), "leading prose breaks the match");
	const [a] = fullBodyBypassMatchers([/^\/merge$/]);
	assert.ok(a.test("/merge") && !a.test("merge please /merge"), "already-anchored patterns unaffected");
});
