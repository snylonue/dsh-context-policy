// Provider billing fold adapted from DeepSeek Harness 0.2.0-rc.2 (MIT).
import { deepEqualJson } from "@deepseek-ai/dsh-util-values";
import { usageOf } from "./core.js";
import type {
	SessionProjectionStateMap,
	ProjectionDefinition,
} from "@deepseek-ai/dsh-session-projection";
import type { TokenUsageProjection } from "@deepseek-ai/dsh-token-meter";
import { z } from "zod";
import type { MeterEvent } from "./types.js";

const count = z.number().int().nonnegative();
const bucketsSchema = z
	.object({
		uncachedInputTokens: count,
		outputTokens: count,
		cacheReadTokens: count,
		cacheWriteTokens: count,
	})
	.strict();

export const usageProjection = {
	key: "tokenUsage",
	stateVersion: 2,
	stateSchema: z
		.object({
			totals: bucketsSchema,
			last: z
				.object({ turn: count, step: count, buckets: bucketsSchema })
				.nullable(),
		})
		.strict(),
	init: () => ({
		totals: {
			uncachedInputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		},
		last: null,
	}),
	apply: (
		state: SessionProjectionStateMap["tokenUsage"],
		event: MeterEvent,
	) => {
		if (event.type === "llm/retry-started")
			return state.last?.turn === event.data.turn &&
				state.last.step === event.data.step
				? { ...state, last: null }
				: state;
		if (
			event.type !== "assistant/message" &&
			event.type !== "assistant/attempt"
		)
			return state;
		const usage = usageOf(event);
		if (usage === undefined) return state;
		const { turn, step } = event.data;
		const buckets: TokenUsageProjection = {
			uncachedInputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			cacheReadTokens: usage.cacheReadTokens ?? 0,
			cacheWriteTokens: usage.cacheWriteTokens ?? 0,
		};
		const previous =
			state.last?.turn === turn && state.last.step === step
				? state.last.buckets
				: undefined;
		if (previous && deepEqualJson(previous, buckets)) return state;
		return {
			totals: {
				uncachedInputTokens:
					state.totals.uncachedInputTokens -
					(previous?.uncachedInputTokens ?? 0) +
					buckets.uncachedInputTokens,
				outputTokens:
					state.totals.outputTokens -
					(previous?.outputTokens ?? 0) +
					buckets.outputTokens,
				cacheReadTokens:
					state.totals.cacheReadTokens -
					(previous?.cacheReadTokens ?? 0) +
					buckets.cacheReadTokens,
				cacheWriteTokens:
					state.totals.cacheWriteTokens -
					(previous?.cacheWriteTokens ?? 0) +
					buckets.cacheWriteTokens,
			},
			last: { turn, step, buckets },
		};
	},
	wire: {
		viewSchema: bucketsSchema,
		view: (state: SessionProjectionStateMap["tokenUsage"]) => state.totals,
	},
} satisfies ProjectionDefinition<"tokenUsage">;
