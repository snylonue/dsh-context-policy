import type { Message } from "@deepseek-ai/dsh-llm";
import type { EpochHeader, SessionEvent } from "@deepseek-ai/dsh-session";
import { SessionLogOffset, SessionSeq } from "@deepseek-ai/dsh-session";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import type {
	ContextBreakdownProjection,
	ContextPressureProjection,
} from "@deepseek-ai/dsh-token-meter";
import { z } from "zod";
import type { MeterServices } from "./core.js";
import { fold, initialState, measureState } from "./core.js";
import type { MeterConfig, ReplayNode, ReplayState } from "./types.js";

const count = z.number().int().nonnegative();
const nodeSchema = z.object({
	seq: count.transform(SessionSeq),
	message: z.custom<Message>().nullable(),
});
const replaySchema = z.object({
	nodes: z.array(nodeSchema),
	header: z.custom<EpochHeader>().nullable(),
	anchor: z.custom<NonNullable<ReplayState["anchor"]>>().nullable(),
	logRevision: count.transform(SessionLogOffset),
});
export const replayProjection: ProjectionDefinition<"contextPolicyMeter"> = {
	key: "contextPolicyMeter",
	stateVersion: 2,
	stateSchema: replaySchema,
	init: initialState,
	apply: fold,
};

// These native projection keys must satisfy the DSH 0.2.1-rc.2 state contract.
interface DisplayState extends ReplayState {
	systems: { seq: SessionSeq; tokens: number }[];
	nodes: (ReplayNode & { system: boolean; heuristicTokens: number })[];
	surfaceTokens: number;
	breakdown: ContextBreakdownProjection;
	contextWindow?: number;
}
const breakdownSchema = z.object({
	systemTokens: count,
	toolsTokens: count,
	messageTokens: count,
});
const displaySchema = replaySchema.extend({
	systems: z.array(
		z.object({ seq: count.transform(SessionSeq), tokens: count }),
	),
	nodes: z.array(
		nodeSchema.extend({ system: z.boolean(), heuristicTokens: count }),
	),
	surfaceTokens: count,
	breakdown: breakdownSchema,
	contextWindow: z.number().int().positive().optional(),
});
function initialDisplayState(): DisplayState {
	return {
		...initialState(),
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
	const next = fold(state, event);
	const { contextWindow, ...withoutWindow } = {
		...next,
		contextWindow: state.contextWindow,
	};
	const window =
		event.type === "request/context" ? event.data.contextWindow : contextWindow;
	if (
		next.nodes === state.nodes &&
		next.header === state.header &&
		next.anchor === state.anchor &&
		window === state.contextWindow
	)
		return state;
	const measurement = measureState(next, config, services);
	// Empty system events have no derived Message but still occupy a surface position.
	const systemSeqs = new Set(state.systems.map((node) => node.seq));
	const nodes = next.nodes.map((node, index) => ({
		...node,
		system:
			systemSeqs.has(node.seq) ||
			(event.type === "system/message" && node.seq === event.seq),
		// Native consumers use this field; it carries the model count, not a second estimator.
		heuristicTokens: measurement.nodes[index].tokens,
	}));
	const surfaceTokens = measurement.surfaceTokens;
	const systems = nodes.flatMap((node) =>
		node.system ? [{ seq: node.seq, tokens: node.heuristicTokens }] : [],
	);
	const systemTokens = systems.findLast((node) => node.tokens > 0)?.tokens ?? 0;
	return {
		...withoutWindow,
		systems,
		nodes,
		surfaceTokens,
		breakdown: {
			systemTokens,
			toolsTokens: measurement.toolsTokens,
			messageTokens: surfaceTokens - systemTokens,
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
		const measurement = measureState(state, config, services);
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
		stateVersion: 9,
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
