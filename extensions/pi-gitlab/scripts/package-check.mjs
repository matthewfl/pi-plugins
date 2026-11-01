import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "pi-gitlab-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
try {
	const output = execFileSync(npm, ["pack", "--json", "--pack-destination", temp], { cwd: root, encoding: "utf8" });
	const result = JSON.parse(output);
	const pack = Array.isArray(result) ? result[0] : Object.values(result)[0];
	const files = pack.files.map((file) => file.path);
	for (const expected of ["index.ts", "dist/bin/pi-gitlab.js", "skills/gitlab-mr-review/SKILL.md", "LICENSE", "README.md"]) {
		assert.ok(files.includes(expected), `missing ${expected}`);
	}
	assert.ok(files.every((file) => !/^(test|scripts|node_modules)\//.test(file)), "development files must not ship");
	execFileSync(npm, ["install", "--prefix", temp, "--omit=peer", "--ignore-scripts", "--no-audit", "--no-fund", join(temp, pack.filename)], { stdio: "pipe" });
	const installed = join(temp, "node_modules", "@matthewfl", "pi-gitlab");
	const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
	assert.equal(manifest.name, "@matthewfl/pi-gitlab");
	assert.equal(manifest.publishConfig.access, "public");
	assert.notEqual(manifest.private, true);
	assert.ok(files.includes(manifest.pi.extensions[0].replace(/^\.\//, "")));
	const cli = spawnSync(process.execPath, [join(installed, manifest.bin["pi-gitlab"]), "skill", "--quiet"], { encoding: "utf8" });
	assert.equal(cli.status, 0, cli.stderr);
	assert.equal(cli.stdout, readFileSync(join(root, "skills/gitlab-mr-review/SKILL.md"), "utf8") + "\n");
	execFileSync(process.execPath, [join(root, "scripts/rpc-load-check.mjs")], {
		env: { ...process.env, PI_GITLAB_PACKAGE: installed },
		stdio: "inherit",
	});
	console.log(`Package check passed: ${files.length} files; installed CLI prints the bundled skill and Pi loads the installed extension.`);
} finally {
	rmSync(temp, { recursive: true, force: true });
}
