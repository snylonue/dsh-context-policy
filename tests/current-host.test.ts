import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const supportedHosts = "0.2.1-rc.2 || 0.2.1-rc.3";
const testedHost = "0.2.1-rc.3";

test("declares only the verified DSH rc.2 and rc.3 hosts", () => {
	const manifest = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	);
	assert.equal(manifest.engines.dsh, supportedHosts);
	assert.equal(manifest.peerDependencies["@deepseek-ai/cordis"], "~4.0.5");
	for (const [name, version] of Object.entries(manifest.peerDependencies))
		if (name.startsWith("@deepseek-ai/dsh-"))
			assert.equal(version, supportedHosts, name);
	for (const [name, version] of Object.entries(manifest.devDependencies)) {
		if (!name.startsWith("@deepseek-ai/dsh-")) continue;
		assert.equal(version, testedHost, name);
		const installed = JSON.parse(
			readFileSync(
				new URL(`../node_modules/${name}/package.json`, import.meta.url),
				"utf8",
			),
		);
		assert.equal(installed.version, testedHost, `${name} installed version`);
	}
});
