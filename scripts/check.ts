import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const cwd = fileURLToPath(new URL("../", import.meta.url));
for (const args of [
	[require.resolve("typescript/bin/tsc"), "-p", "tsconfig.json"],
	[require.resolve("typescript/bin/tsc"), "-p", "tsconfig.check.json"],
	[
		"--test",
		"tests/current-host.test.ts",
		"tests/policy.test.ts",
		"tests/compact.test.ts",
		"tests/replay.test.ts",
		"tests/bundle.test.ts",
		"tests/tokenizers.test.ts",
	],
]) {
	const result = spawnSync(process.execPath, args, { cwd, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
