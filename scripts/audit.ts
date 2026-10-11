/** Aggregate local prediction errors; never emits conversation content. */
import { readFile } from "node:fs/promises";
import { zstdDecompressSync } from "node:zlib";
import { basename, dirname } from "node:path";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import {
	initialState,
	fold,
	usageOf,
	inputTokens,
	measureState,
} from "../dist/core.js";
const meterConfig = { defaultTokenizer: "o200k_base", modelPolicies: [] };
const files = process.argv.slice(2);
if (!files.length)
	throw new Error("Pass one or more session.v4.jsonl.zstd paths");
const percentile = (values: number[], fraction: number) => {
	const sorted = values.toSorted((a, b) => a - b);
	return sorted.length
		? sorted[Math.floor((sorted.length - 1) * fraction)]
		: null;
};
const rows = [];
for (const file of files) {
	const compressed = await readFile(file);
	const decoded: Buffer[] = [];
	for (let offset = 0; offset < compressed.length; ) {
		const result = zstdDecompressSync(compressed.subarray(offset), {
			info: true,
		}) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
		if (!result.engine.bytesWritten)
			throw new Error("Invalid empty Zstandard frame");
		decoded.push(result.buffer);
		offset += result.engine.bytesWritten;
	}
	const records = Buffer.concat(decoded)
		.toString("utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	let state = initialState(),
		zeroUsagePreserved = 0;
	const errors: number[] = [],
		initialErrors: number[] = [];
	const regressions = [];
	for (const raw of records) {
		if (typeof raw.seq !== "number" || typeof raw.type !== "string") continue;
		const event = raw as SessionEvent;
		if (
			event.type === "assistant/message" ||
			event.type === "assistant/attempt"
		) {
			const before = measureState(state, meterConfig);
			const usage = usageOf(event);
			if (usage && inputTokens(usage) === 0) {
				const after = measureState(fold(state, event), meterConfig);
				if (
					event.type === "assistant/attempt" &&
					before.totalTokens === after.totalTokens
				)
					zeroUsagePreserved++;
			}
			if (
				event.type === "assistant/message" &&
				usage &&
				inputTokens(usage) > 0
			) {
				const actual = inputTokens(usage),
					error = (before.totalTokens - actual) / actual;
				(before.baseline.kind === "usage" ? errors : initialErrors).push(error);
				if ([30, 35, 83].includes(event.seq))
					regressions.push({
						seq: event.seq,
						predicted: before.totalTokens,
						actual,
						errorPercent: Math.round(error * 10000) / 100,
					});
			}
		}
		state = fold(state, event);
	}
	const absolute = errors.map(Math.abs);
	rows.push({
		session: basename(dirname(file)),
		successfulAnchoredRequests: errors.length,
		unanchoredRequests: initialErrors.length,
		zeroUsagePreserved,
		anchoredMedianAbsoluteErrorPercent: (percentile(absolute, 0.5) ?? 0) * 100,
		anchoredP90AbsoluteErrorPercent: (percentile(absolute, 0.9) ?? 0) * 100,
		anchoredWorstAbsoluteErrorPercent: Math.max(0, ...absolute) * 100,
		regressions,
	});
}
console.log(
	JSON.stringify(
		{
			tokenizer: "o200k_base",
			adapterPricingAvailable: false,
			note: "Offline estimates omit provider-specific image/file projections and serialization.",
			rows,
		},
		null,
		2,
	),
);
