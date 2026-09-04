// Minimal test shim for @earendil-works/pi-coding-agent.
// goal.ts only imports { defineTool, getAgentDir } at runtime (everything else
// is a type-only import). The real dist/index.js statically pulls in the
// whole interactive-mode + experimental chain, which is far more than the
// behavior under test needs — and breaks whenever pi's packaging changes.
"use strict";

const { join } = require("node:path");
const { homedir } = require("node:os");

function defineTool(def) {
	return def;
}

function getAgentDir() {
	return process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
}

module.exports = { defineTool, getAgentDir };
