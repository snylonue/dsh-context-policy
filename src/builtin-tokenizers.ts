import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { Tokenizer } from "@huggingface/tokenizers";
import { util } from "zod";

export function createTokenizerCounter(
	asset: string,
): (text: string) => number {
	const tokenizer = util.cached(() => {
		const data = JSON.parse(
			gunzipSync(
				readFileSync(
					new URL(`../assets/${asset}/tokenizer.json.gz`, import.meta.url),
				),
			).toString("utf8"),
		);
		// Count literal message content as ordinary text. Request framing is
		// accounted for separately by the meter.
		data.added_tokens = [];
		return new Tokenizer(data, {});
	});
	return (text) =>
		tokenizer.value.tokenize(text, { add_special_tokens: false }).length;
}
