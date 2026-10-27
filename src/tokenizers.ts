import type { EpochHeader } from "@deepseek-ai/dsh-session";
import type { MeterConfig, ResolvedPolicy } from "./types.js";
import { createTokenizerCounter } from "./builtin-tokenizers.js";

// Treat special-token-looking user text as ordinary text, rather than
// rejecting or interpreting it as control.
const caches = new Map<
	(text: string) => number,
	{ values: Map<string, number>; chars: number }
>();
const tokenizers = new Map<string, (text: string) => number>([
	["deepseek_v4", createTokenizerCounter("deepseek-v4")],
	["o200k_base", createTokenizerCounter("o200k-base")],
]);

let generation = 0;
/** Invalidates derived numeric summaries when custom counters are replaced. */
export const tokenizerGeneration = () => generation;

export function registerTokenizer(
	name: string,
	count: (text: string) => number,
) {
	if (tokenizers.has(name))
		throw new Error(`Tokenizer already registered: ${name}`);
	tokenizers.set(name, count);
	generation++;
	return () => {
		if (tokenizers.get(name) === count) {
			tokenizers.delete(name);
			caches.delete(count);
			generation++;
		}
	};
}

export function countText(text: string, tokenizer: string): number {
	const count = tokenizers.get(tokenizer);
	if (!count) throw new Error(`Unknown tokenizer: ${tokenizer}`);
	let cache = caches.get(count);
	if (!cache) {
		cache = { values: new Map(), chars: 0 };
		caches.set(count, cache);
	}
	const cached = cache.values.get(text);
	if (cached !== undefined) return cached;
	const result = count(text);
	if (!Number.isSafeInteger(result) || result < 0)
		throw new TypeError("Tokenizer must return a non-negative safe integer");
	if (text.length <= 2000000) {
		while (cache.values.size >= 512 || cache.chars + text.length > 2000000) {
			const oldest = cache.values.keys().next();
			if (oldest.done) break;
			const key = oldest.value;
			cache.chars -= key.length;
			cache.values.delete(key);
		}
		cache.values.set(text, result);
		cache.chars += text.length;
	}
	return result;
}

export function resolvePolicy(
	config: MeterConfig,
	header: EpochHeader | null,
): Readonly<ResolvedPolicy> {
	const policies = config.modelPolicies;
	const route = header?.config;
	const match =
		policies.find(
			(p) => p.provider === route?.provider && p.model === route?.model,
		) ??
		policies.find((p) => p.provider === undefined && p.model === route?.model);
	const providerPolicy =
		route &&
		config.providerPolicies?.find((p) => p.provider === route.provider);
	return Object.freeze({
		tokensPerMessage:
			match?.tokensPerMessage ?? providerPolicy?.tokensPerMessage ?? 3,
		toolsOverhead: match?.toolsOverhead ?? providerPolicy?.toolsOverhead ?? 4,
		replyPrimingTokens:
			match?.replyPrimingTokens ?? providerPolicy?.replyPrimingTokens ?? 3,
		includeReasoning:
			match?.includeReasoning ?? providerPolicy?.includeReasoning ?? false,
		tokenizer:
			match?.tokenizer ?? providerPolicy?.tokenizer ?? config.defaultTokenizer,
	});
}
