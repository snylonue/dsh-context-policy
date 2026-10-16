import { SessionLogOffset, SessionSeq } from "@deepseek-ai/dsh-session";
import type { EpochHeader, SessionEvent } from "@deepseek-ai/dsh-session";
import type { Message } from "@deepseek-ai/dsh-llm";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import type {
	ContextPressureProjection,
	ContextBreakdownProjection,
} from "@deepseek-ai/dsh-token-meter";
import { z } from "zod";
import { initialState, fold, measureState } from "./core.js";
import type { MeterServices } from "./core.js";
import type { MeterConfig, ReplayState, ReplayNode } from "./types.js";

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

// Retain the native state fields so callers of the original keys remain type-compatible.
interface DisplayState extends ReplayState {
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
	const nodes = next.nodes.map((node, index) => ({
		...node,
		system: node.message?.role === "system",
		// Native consumers use this field; it carries the model count, not a second estimator.
		heuristicTokens: measurement.nodes[index].tokens,
	}));
	const surfaceTokens = measurement.surfaceTokens;
	const systemTokens =
		nodes.findLast((node) => node.system && node.message?.content.length)
			?.heuristicTokens ?? 0;
	return {
		...withoutWindow,
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
		const system = state.nodes.findLast(
			(node) => node.system && node.message?.content.length,
		);
		const systemTokens =
			measurement.nodes.find((node) => node.seq === system?.seq)?.tokens ?? 0;
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
		stateVersion: 8,
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
