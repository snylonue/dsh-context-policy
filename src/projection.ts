import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { SessionSeq } from "@deepseek-ai/dsh-session";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import type {
	ContextBreakdownProjection,
	ContextPressureProjection,
} from "@deepseek-ai/dsh-token-meter";
import { z } from "zod";
import type { MeterServices } from "./core.js";
import {
	compactSchema,
	compactVersion,
	foldCompact,
	initialCompactState,
	measureCompact,
} from "./compact.js";
import type { CompactState } from "./compact.js";
import type { MeterConfig } from "./types.js";

const count = z.number().int().nonnegative();
export function createReplayProjection(config: MeterConfig) {
	return {
		key: "contextPolicyMeter",
		stateVersion: compactVersion(config),
		stateSchema: compactSchema,
		init: initialCompactState,
		apply: (state: CompactState, event: SessionEvent) =>
			foldCompact(state, event, config),
	} satisfies ProjectionDefinition<"contextPolicyMeter">;
}
export const replayProjection = createReplayProjection({
	defaultTokenizer: "deepseek_v4",
	modelPolicies: [],
});

// Keep the native state contract without retaining message bodies or tool schemas.
interface DisplayState extends CompactState {
	systems: { seq: SessionSeq; tokens: number }[];
	nodes: (CompactState["nodes"][number] & { heuristicTokens: number })[];
	surfaceTokens: number;
	breakdown: ContextBreakdownProjection;
	contextWindow?: number;
}
const breakdownSchema = z.object({
	systemTokens: count,
	toolsTokens: count,
	messageTokens: count,
});
const displaySchema = compactSchema.extend({
	systems: z.array(
		z.object({ seq: count.transform(SessionSeq), tokens: count }),
	),
	nodes: z.array(
		compactSchema.shape.nodes.element.extend({ heuristicTokens: count }),
	),
	surfaceTokens: count,
	breakdown: breakdownSchema,
	contextWindow: z.number().int().positive().optional(),
});
function initialDisplayState(): DisplayState {
	return {
		...initialCompactState(),
		systems: [],
		nodes: [],
		surfaceTokens: 0,
		breakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 },
	};
}
function foldDisplay(
	state: DisplayState,
	event: SessionEvent,
	config: MeterConfig,
	services: MeterServices,
): DisplayState {
	const next = foldCompact(state, event, config);
	const window =
		event.type === "request/context"
			? event.data.contextWindow
			: state.contextWindow;
	if (
		next.nodes === state.nodes &&
		next.header === state.header &&
		next.anchor === state.anchor &&
		window === state.contextWindow
	)
		return state;
	const measurement = measureCompact(next, config, services);
	const nodes = next.nodes.map((node, index) => ({
		...node,
		heuristicTokens: measurement.nodes[index].tokens,
	}));
	const systems = nodes.flatMap((node) =>
		node.system ? [{ seq: node.seq, tokens: node.heuristicTokens }] : [],
	);
	const systemTokens = systems.findLast((node) => node.tokens > 0)?.tokens ?? 0;
	const { contextWindow: _previousWindow, ...withoutWindow } =
		next as CompactState & { contextWindow?: number };
	return {
		...withoutWindow,
		systems,
		nodes,
		surfaceTokens: measurement.surfaceTokens,
		breakdown: {
			systemTokens,
			toolsTokens: measurement.toolsTokens,
			messageTokens: measurement.surfaceTokens - systemTokens,
		},
		...(window === undefined ? {} : { contextWindow: window }),
	};
}

export function createDisplayProjections(
	config: MeterConfig,
	services: MeterServices,
) {
	const views = new WeakMap<
		DisplayState,
		{
			pressure: ContextPressureProjection;
			breakdown: ContextBreakdownProjection;
		}
	>();
	const view = (state: DisplayState) => {
		const cached = views.get(state);
		if (cached) return cached;
		const measurement = measureCompact(state, config, services);
		const systemTokens =
			measurement.nodes.findLast(
				(node, index) => state.nodes[index].system && node.tokens > 0,
			)?.tokens ?? 0;
		const pressure: ContextPressureProjection = {
			projectedTokens: measurement.totalTokens,
			...(measurement.baseline.kind === "usage"
				? { pressureTokens: measurement.baseline.tokens }
				: {}),
			...(state.contextWindow === undefined
				? {}
				: { contextWindow: state.contextWindow }),
		};
		const breakdown = {
			systemTokens,
			toolsTokens: measurement.toolsTokens,
			messageTokens: measurement.surfaceTokens - systemTokens,
		};
		const value = { pressure, breakdown };
		views.set(state, value);
		return value;
	};
	const replay = {
		stateVersion: compactVersion(config),
		stateSchema: displaySchema,
		init: initialDisplayState,
		apply: (state: DisplayState, event: SessionEvent) =>
			foldDisplay(state, event, config, services),
	};
	const pressure = {
		...replay,
		key: "contextPressure",
		wire: {
			viewSchema: z.object({
				pressureTokens: count.optional(),
				projectedTokens: count,
				contextWindow: z.number().int().positive().optional(),
			}),
			view: (state: DisplayState) => view(state).pressure,
		},
	} satisfies ProjectionDefinition<"contextPressure", DisplayState>;
	const breakdown = {
		...replay,
		key: "contextBreakdown",
		wire: {
			viewSchema: breakdownSchema,
			view: (state: DisplayState) => view(state).breakdown,
		},
	} satisfies ProjectionDefinition<"contextBreakdown", DisplayState>;
	return { pressure, breakdown };
}
