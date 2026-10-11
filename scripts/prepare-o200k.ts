import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

// Input: Xenova/gpt-4o tokenizer.json at revision
// 7956d98f2a83b2751a98ea7136fdf7fe6cf54e69 (see assets/o200k-base/README.md).
const input = process.argv[2];
if (!input)
	throw new Error("Usage: node scripts/prepare-o200k.ts <tokenizer.json>");
const source = readFileSync(input);
if (
	createHash("sha256").update(source).digest("hex") !==
	"43a3ad4618a6a938f8c2614154ea10c31ad53a62d5683ae0b0e6133575cef07e"
)
	throw new Error("Unexpected o200k_base tokenizer source checksum");
const data = JSON.parse(source.toString("utf8"));
data.added_tokens = [];
// Tiktoken emits a whole pre-tokenized piece when it exists in the vocabulary.
data.model.ignore_merges = true;
// Preserve js-tiktoken's ECMAScript whitespace semantics, including FEFF and
// excluding U+0085. Hugging Face otherwise translates \s as Oniguruma whitespace.
const whitespace = String.raw`\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF`;
const split = data.pre_tokenizer.pretokenizers[0];
split.pattern.Regex = split.pattern.Regex.replaceAll(
	String.raw`[^\s\p{L}\p{N}]`,
	String.raw`[^${whitespace}\p{L}\p{N}]`,
)
	.replaceAll(String.raw`\s`, `[${whitespace}]`)
	.replaceAll(String.raw`\S`, `[^${whitespace}]`);
const output = new URL("../assets/o200k-base/", import.meta.url);
mkdirSync(output, { recursive: true });
const json = Buffer.from(JSON.stringify(data));
writeFileSync(
	new URL("tokenizer.json.gz", output),
	gzipSync(json, { level: 9 }),
);
console.log(
	"o200k_base tokenizer SHA-256:",
	createHash("sha256").update(json).digest("hex"),
);
