import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { countText, registerTokenizer } from "../dist/tokenizers.js";
import fixtures from "./deepseek-v4-fixtures.json" with { type: "json" };
import gptFixtures from "./o200k-base-fixtures.json" with { type: "json" };

test("bundled DeepSeek V4 vocabulary matches the pinned official asset", () => {
	const data = gunzipSync(
		readFileSync(
			new URL("../assets/deepseek-v4/tokenizer.json.gz", import.meta.url),
		),
	);
	assert.equal(
		createHash("sha256").update(data).digest("hex"),
		"8f9f37ca37fdc4f5fd36d5cf4d3b0e8392edb4e894fd10cc0d70b4957c8633cf",
	);
});

test("bundled o200k_base vocabulary matches the compatible converted asset", () => {
	const data = gunzipSync(
		readFileSync(
			new URL("../assets/o200k-base/tokenizer.json.gz", import.meta.url),
		),
	);
	assert.equal(
		createHash("sha256").update(data).digest("hex"),
		"d807dc8b57ba3e3dbddb94324dcb4e359e20d83a8c8d68a73d2e8b01e70a1ace",
	);
});

// Counts captured from the previous js-tiktoken 1.0.21 implementation.
test("o200k_base preserves GPT counts for Unicode, code, literal markers and whitespace", () => {
	for (const { text, tokens } of gptFixtures.cases) {
		assert.equal(countText(text, "o200k_base"), tokens, JSON.stringify(text));
	}
});

// Golden counts come from Hugging Face Rust tokenizers 0.23.2, with
// added_tokens removed and add_special_tokens=False (ordinary message text).
test("deepseek_v4 matches reference counts for multilingual text, code and control markers", () => {
	for (const { text, tokens } of fixtures.cases) {
		assert.equal(countText(text, "deepseek_v4"), tokens, JSON.stringify(text));
	}
	assert.throws(
		() => registerTokenizer("deepseek_v4", () => 0),
		/already registered/,
	);
});
