import { execFileSync } from "node:child_process";
import { chmod, cp, rm } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });
execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.build.json"], {
	cwd: new URL("../", import.meta.url),
	stdio: "inherit",
});

// Keep the guide at the same relative path for both the source and compiled CLI.
await cp(new URL("../skills/", import.meta.url), new URL("../dist/skills/", import.meta.url), { recursive: true });
await chmod(new URL("../dist/bin/pi-gitlab.js", import.meta.url), 0o755);
