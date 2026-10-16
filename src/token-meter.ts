import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import type { EpochHeader, Session } from "@deepseek-ai/dsh-session";
import { SessionSeq } from "@deepseek-ai/dsh-session";
import type { Message } from "@deepseek-ai/dsh-llm";
import type { MeterConfig, MeterConfigInput, ReplayState } from "./types.js";
import type { MeterServices } from "./core.js";
import "@deepseek-ai/dsh-session-projection";
import settings from "@deepseek-ai/schemastery";
import { measureState, priceSurface } from "./core.js";
import { createDisplayProjections, replayProjection } from "./projection.js";
import { usageProjection } from "./usage.js";

declare module "@deepseek-ai/dsh-session-projection" {
	interface SessionProjectionStateMap {
		contextPolicyMeter: ReplayState;
	}
}

const policyFields = {
	tokenizer: settings.string(),
	tokensPerMessage: settings.number().min(0).step(1),
	toolsOverhead: settings.number().min(0).step(1),
	replyPrimingTokens: settings.number().min(0).step(1),
	includeReasoning: settings.boolean(),
};

export const Config: settings<MeterConfigInput, MeterConfig> = settings.object({
	defaultTokenizer: settings.string().default("deepseek_v4"),
	providerPolicies: settings
		.array(
			settings.object({
				...policyFields,
				provider: settings.string().required(),
			}),
		)
		.default([]),
	modelPolicies: settings
		.array(
			settings.object({
				...policyFields,
				provider: settings.string(),
				model: settings.string().required(),
			}),
		)
		.default([]),
});
export const inject = ["sessionProjections"];

export class ModelTokenMeter extends Service {
	constructor(ctx: Context, config: MeterConfig) {
		super(ctx, "tokenMeter");
		this.config = structuredClone(config);
		this.services = {
			get llm() {
				return ctx.get("llm");
			},
		};
		const display = createDisplayProjections(this.config, this.services);
		ctx.sessionProjections.register(usageProjection);
		ctx.sessionProjections.register(display.pressure);
		ctx.sessionProjections.register(display.breakdown);
		ctx.sessionProjections.register(replayProjection);
	}
	config: MeterConfig;
	services: MeterServices;
	measure(session: Session, requestHeader?: EpochHeader) {
		const state = this.ctx.sessionProjections.stateOf(
			session,
			"contextPolicyMeter",
		);
		if (!state)
			throw new Error(
				"ModelTokenMeter contextPolicyMeter projection is unavailable",
			);
		return measureState(state, this.config, this.services, requestHeader);
	}
	estimateMessage(message: Message) {
		return priceSurface(
			[{ seq: SessionSeq(0), message }],
			null,
			this.config,
			this.services,
		).surfaceTokens;
	}
}

export function apply(ctx: Context, config: MeterConfig) {
	new ModelTokenMeter(ctx, config);
}

export default { Config, inject, apply };
