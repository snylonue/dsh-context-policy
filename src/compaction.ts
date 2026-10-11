// Range selection and lock checks adapted from DeepSeek Harness 0.2.0-rc.2 (MIT).
import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import BasicCompactionEngine from "@deepseek-ai/dsh-compaction-basic";
import type {
	BasicCompactionConfig,
	CompactionPolicyConfig,
	ResolvedTargetPolicy,
	ResolvedCompactSpec,
	ResolvedRetention,
} from "@deepseek-ai/dsh-compaction-basic";
import {
	ManualCompactionError,
	toolPairingBalancedBefore,
} from "@deepseek-ai/dsh-compaction";
import type { CompactionResult } from "@deepseek-ai/dsh-compaction";
import { isSurfaceEvent } from "@deepseek-ai/dsh-session";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import { z } from "zod";
import type { Session } from "@deepseek-ai/dsh-session";
import type { TokenMeasurement } from "@deepseek-ai/dsh-token-meter";

export interface PercentageCompactionConfig extends BasicCompactionConfig {
	providerPolicies?: (CompactionPolicyConfig & { provider: string })[];
	thresholdRatio: number;
	maxTokens: number;
	modelPolicies: NonNullable<BasicCompactionConfig["modelPolicies"]>;
	auto: boolean;
}

type Agent = Parameters<BasicCompactionEngine["compactIfNeeded"]>[0];
type Trigger = Parameters<BasicCompactionEngine["compactIfNeeded"]>[1];
const fields = {
	thresholdRatio: Schema.number().min(0).max(1),
	headroomTokens: Schema.natural(),
	retainRatio: Schema.number().min(0).max(1),
	retainTokens: Schema.natural(),
	summarizationProvider: Schema.string(),
	summarizationModel: Schema.string(),
	maxTokens: Schema.natural(),
	compactionRetries: Schema.natural(),
	maxOverflowRetries: Schema.natural(),
};

function mergePolicy<T extends CompactionPolicyConfig>(base: CompactionPolicyConfig, override: T): T {
	const merged = { ...base, ...Object.fromEntries(
		Object.entries(override).filter(([, value]) => value !== undefined),
	) } as T;
	if (override.retainTokens !== undefined && override.retainRatio === undefined) delete merged.retainRatio;
	if (override.retainRatio !== undefined && override.retainTokens === undefined) delete merged.retainTokens;
	return merged;
}

/** Both budgets are percentages of the full context window. */
export function resolveCompactSpec(
	policy: ResolvedTargetPolicy,
	contextWindow: number,
): ResolvedCompactSpec {
	if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0)
		throw new Error(
			"compaction: contextWindow must be a positive safe integer",
		);
	const thresholdTokens = Math.floor(contextWindow * policy.thresholdRatio);
	const retainTokens =
		policy.retainTokens !== undefined
			? policy.retainTokens
			: Math.floor(contextWindow * policy.retainRatio);
	if (thresholdTokens <= 0 || retainTokens >= thresholdTokens)
		throw new Error(
			"compaction: retain budget must be below the percentage threshold",
		);
	return Object.freeze({
		target: policy.target,
		contextWindow,
		thresholdRatio: policy.thresholdRatio,
		thresholdTokens,
		retainTokens,
		summarizationProvider: policy.summarizationProvider,
		summarizationModel: policy.summarizationModel,
		maxTokens: policy.maxTokens,
		compactionRetries: policy.compactionRetries,
		maxOverflowRetries: policy.maxOverflowRetries,
	});
}

/** Preserve system head and whole tool-call/result groups. */
export function selectCompactableRange(
	session: Session,
	measurement: TokenMeasurement,
	retainTokens: number,
	systemHead: boolean,
) {
	const nodes = measurement.nodes;
	if (!nodes.length) return null;
	const surface = session.surface.nodes;
	if (
		surface.length !== nodes.length ||
		surface.some((seq, i) => seq !== nodes[i].seq)
	)
		throw new Error(
			"compaction: token-meter surface does not match the session surface",
		);
	const first = systemHead ? 1 : 0;
	let total = 0;
	let keep = nodes.length;
	for (let i = nodes.length - 1; i >= 0; i--) {
		total += nodes[i].tokens;
		keep = i;
		if (total >= retainTokens) break;
	}
	while (keep > first && !toolPairingBalancedBefore(session, surface[keep]))
		keep--;
	return keep <= first
		? null
		: { start: surface[first], end: surface[keep - 1] };
}

interface CompactionEntryState {
	active: boolean;
	headSeq: number | null;
	systemHead: boolean;
}

declare module "@deepseek-ai/dsh-session-projection" {
	interface SessionProjectionStateMap {
		contextPolicyCompaction: CompactionEntryState;
	}
}

const compactionEntry: ProjectionDefinition<"contextPolicyCompaction"> = {
	key: "contextPolicyCompaction",
	stateVersion: 1,
	stateSchema: z.object({
		active: z.boolean(),
		headSeq: z.number().int().nonnegative().nullable(),
		systemHead: z.boolean(),
	}),
	init: () => ({ active: false, headSeq: null, systemHead: false }),
	apply: (state, event) => {
		if (event.type === "compaction/start") return { ...state, active: true };
		if (event.type === "compaction/end" || event.type === "session/end-seed")
			return state.active ? { ...state, active: false } : state;
		if (
			isSurfaceEvent(event) &&
			(state.headSeq === null ||
				(event.surfaceOp !== "append" &&
					event.surfaceOp.startSeq === state.headSeq))
		)
			return {
				...state,
				headSeq: event.seq,
				systemHead: event.type === "system/message",
			};
		return state;
	},
};

/** Reuse the official summarizer, transactions, commands and overflow listeners. */
export class PercentageCompactionEngine extends BasicCompactionEngine {
	static override inject = [
		...BasicCompactionEngine.inject,
		"sessionProjections",
	];
	static override Config: Schema<
		Partial<PercentageCompactionConfig>,
		PercentageCompactionConfig
	> = Schema.object({
		...fields,
		thresholdRatio: Schema.number().min(0).max(1).default(0.8),
		maxTokens: Schema.natural().default(65536),
		auto: Schema.boolean().default(true),
		providerPolicies: Schema.array(
			Schema.object({ ...fields, provider: Schema.string().required() }),
		).default([]),
		modelPolicies: Schema.array(
			Schema.object({
				...fields,
				provider: Schema.string().required(),
				model: Schema.string().required(),
			}),
		).default([]),
	});
	private readonly providerPolicies: NonNullable<PercentageCompactionConfig["providerPolicies"]>;
	constructor(ctx: Context, config: PercentageCompactionConfig) {
		const { providerPolicies = [], ...basic } = config;
		super(ctx, {
			...basic,
			headroomTokens: 0,
			modelPolicies: config.modelPolicies.map((p) => {
				const provider = providerPolicies.find((policy) => policy.provider === p.provider);
				const merged = mergePolicy(provider ?? {}, p);
				return { ...merged, headroomTokens: 0, maxTokens: merged.maxTokens ?? config.maxTokens };
			}),
		});
		this.providerPolicies = structuredClone(providerPolicies);
		ctx.sessionProjections.register(compactionEntry);
	}
	private entryState(session: Session) {
		const state = this.ctx.sessionProjections.stateOf(
			session,
			"contextPolicyCompaction",
		);
		if (!state)
			throw new Error("compaction: entry-state projection is unavailable");
		return state;
	}
	private policy(target: {
		provider: string;
		model: string;
	}): ResolvedTargetPolicy {
		const match = this.config.modelPolicies.find(
			(p) => p.provider === target.provider && p.model === target.model,
		) ?? this.providerPolicies.find((p) => p.provider === target.provider);
		let retention: ResolvedRetention;
		if (match?.retainTokens !== undefined)
			retention = { retainTokens: match.retainTokens };
		else if (match?.retainRatio !== undefined)
			retention = { retainRatio: match.retainRatio };
		else if (this.config.retainTokens !== undefined)
			retention = { retainTokens: this.config.retainTokens };
		else retention = { retainRatio: this.config.retainRatio };
		return {
			thresholdRatio: match?.thresholdRatio ?? this.config.thresholdRatio,
			headroomTokens: 0,
			summarizationProvider:
				match?.summarizationProvider ?? this.config.summarizationProvider,
			summarizationModel:
				match?.summarizationModel ?? this.config.summarizationModel,
			maxTokens: match?.maxTokens ?? this.config.maxTokens,
			compactionRetries:
				match?.compactionRetries ?? this.config.compactionRetries,
			maxOverflowRetries:
				match?.maxOverflowRetries ?? this.config.maxOverflowRetries,
			target,
			...retention,
		};
	}
	override async compactIfNeeded(
		agent: Agent,
		trigger: Trigger,
		signal?: AbortSignal,
	): Promise<CompactionResult | null> {
		const header = agent.session.requestHeader();
		if (!header?.config.provider || !header.config.model) return null;
		const target = {
			provider: header.config.provider,
			model: header.config.model,
		};
		const meter = this.ctx.tokenMeter;
		let measurement = meter.measure(agent.session);
		const prune = this.ctx.get("toolResultPruner");
		if (trigger === "context-overflow") {
			prune?.pruneSession(agent.session);
			measurement = meter.measure(agent.session);
			const range = selectCompactableRange(
				agent.session,
				measurement,
				0,
				this.entryState(agent.session).systemHead,
			);
			return range
				? this.compactRegion(range.start, range.end, agent, signal)
				: null;
		}
		const info = await this.ctx.llm.resolveModelInfo(
			target.provider,
			target.model,
			signal,
		);
		if (this.entryState(agent.session).active)
			throw new ManualCompactionError(
				"busy",
				"automatic pressure compaction: compaction already in progress",
			);
		if (!info.context)
			throw new Error(
				"compaction: configure contextWindow for " +
					target.provider +
					"/" +
					target.model,
			);
		const spec = resolveCompactSpec(
			this.policy(target),
			info.context.contextWindow,
		);
		if (measurement.totalTokens < spec.thresholdTokens) return null;
		prune?.pruneSession(agent.session);
		measurement = meter.measure(agent.session);
		if (measurement.totalTokens < spec.thresholdTokens) return null;
		let result: CompactionResult | null = null;
		for (let attempt = 0; attempt <= spec.compactionRetries; attempt++) {
			const range = selectCompactableRange(
				agent.session,
				measurement,
				spec.retainTokens,
				this.entryState(agent.session).systemHead,
			);
			if (!range) return result;
			result = await this.compactRegion(range.start, range.end, agent, signal);
			measurement = meter.measure(agent.session);
			if (measurement.totalTokens < spec.thresholdTokens) return result;
		}
		throw new Error(
			"compaction still above percentage threshold after " +
				(spec.compactionRetries + 1) +
				" attempts",
		);
	}
}
export default PercentageCompactionEngine;
