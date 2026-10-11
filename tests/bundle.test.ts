import test from "node:test";
import assert from "node:assert/strict";
import { composeEntries, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";

test("bundle composition disables upstream meter and compaction while preserving other plugins", () => {
	const rows = loadOverlayPatches(
		"@snylonue/dsh-context-policy",
		new URL("../cordis.patch.yml", import.meta.url).pathname,
	);
	const base = [
		{
			insert: [
				{ id: "token-meter", name: "@deepseek-ai/dsh-token-meter" },
				{ id: "compaction-basic", name: "@deepseek-ai/dsh-compaction-basic" },
				{ id: "command-compact", name: "@deepseek-ai/dsh-command-compact" },
			],
		},
	];
	const warnings: string[] = [];
	const entries = composeEntries([base, rows], (warning) =>
		warnings.push(warning),
	);
	assert.deepEqual(warnings, []);
	for (const id of ["token-meter", "compaction-basic"])
		assert.equal(entries.find((entry) => entry.id === id)?.disabled, true);
	const active = entries
		.filter((entry) => !entry.disabled)
		.map((entry) => entry.name);
	assert.deepEqual(
		active.toSorted(),
		[
			"@deepseek-ai/dsh-command-compact",
			"@snylonue/dsh-context-policy/token-meter",
			"@snylonue/dsh-context-policy/compaction",
		].toSorted(),
	);
});
