import assert from "node:assert/strict";
import { test } from "node:test";
import * as os from "node:os";
import * as path from "node:path";
import { agentDir, authPath, configPath, dataRoot, itemFilePath } from "../paths.ts";

type Env = Record<string, string | undefined>;

function withEnv(patch: Env, fn: () => void): void {
	const saved: Env = {};
	for (const k of Object.keys(patch)) {
		saved[k] = process.env[k];
		const v = patch[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		fn();
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

test("agent dir default is ~/.pi/agent; PI_CODING_AGENT_DIR overrides it", () => {
	withEnv({ PI_CODING_AGENT_DIR: undefined, PI_GITLAB_DIR: undefined }, () => {
		assert.equal(agentDir(), path.join(os.homedir(), ".pi", "agent"));
		assert.equal(dataRoot(), path.join(os.homedir(), ".pi", "agent", "gitlab"));
	});
	withEnv({ PI_CODING_AGENT_DIR: "/tmp/custom-agent" }, () => {
		assert.equal(agentDir(), "/tmp/custom-agent");
		assert.equal(dataRoot(), "/tmp/custom-agent/gitlab");
		// every derived path follows the agent dir: config/auth and item files
		assert.equal(configPath(), "/tmp/custom-agent/gitlab/config/config.json");
		assert.equal(authPath(), "/tmp/custom-agent/gitlab/config/auth.json");
		const f = itemFilePath({
			baseUrl: "https://gitlab.example", host: "gitlab.example", projectPath: "g/p",
			kind: "mr", iid: 1, url: "https://gitlab.example/g/p/-/merge_requests/1",
		});
		assert.ok(f.startsWith("/tmp/custom-agent/gitlab/mr/"), f);
	});
});

test("PI_GITLAB_DIR beats PI_CODING_AGENT_DIR; whitespace trimmed; empty ignored", () => {
	withEnv({ PI_GITLAB_DIR: "  /tmp/pi-gitlab-dir  ", PI_CODING_AGENT_DIR: "/tmp/custom-agent" }, () => {
		assert.equal(dataRoot(), "/tmp/pi-gitlab-dir");
	});
	withEnv({ PI_GITLAB_DIR: "   ", PI_CODING_AGENT_DIR: "/tmp/custom-agent" }, () => {
		assert.equal(dataRoot(), "/tmp/custom-agent/gitlab", "blank PI_GITLAB_DIR falls through");
	});
	withEnv({ PI_CODING_AGENT_DIR: "   " }, () => {
		assert.equal(agentDir(), path.join(os.homedir(), ".pi", "agent"), "blank env dir ignored like pi's getAgentDir");
	});
});
