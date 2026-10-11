import type {
	EpochHeader,
	SessionSeq,
	SessionLogOffset,
	SessionEvent,
} from "@deepseek-ai/dsh-session";
import type { Message, TokenUsage } from "@deepseek-ai/dsh-llm";

/** Optional domain events; no runtime dependency on their owning plugins. */
export type MeterEvent =
	| SessionEvent
	| {
			type: "image/offload";
			seq: SessionSeq;
			data: { targets: { seq: SessionSeq; imageIndexes: number[] }[] };
	  }
	| {
			type: "llm/retry-started";
			seq: SessionSeq;
			data: { turn: number; step: number };
	  };

export interface TokenPolicy {
	tokenizer?: string;
	tokensPerMessage?: number;
	toolsOverhead?: number;
	replyPrimingTokens?: number;
	includeReasoning?: boolean;
}
export interface ProviderPolicy extends TokenPolicy {
	provider: string;
}
export interface ModelPolicy extends TokenPolicy {
	provider?: string;
	model: string;
}
export interface MeterConfigInput {
	defaultTokenizer?: string;
	providerPolicies?: ProviderPolicy[];
	modelPolicies?: ModelPolicy[];
}
export interface MeterConfig {
	defaultTokenizer: string;
	providerPolicies?: ProviderPolicy[];
	modelPolicies: ModelPolicy[];
}
export interface ResolvedPolicy {
	tokenizer: string;
	tokensPerMessage: number;
	toolsOverhead: number;
	replyPrimingTokens: number;
	includeReasoning: boolean;
}
export interface ReplayNode {
	seq: SessionSeq;
	message: Message | null;
	heuristicTokens: number;
}
export interface ReplayState {
	nodes: readonly ReplayNode[];
	header: EpochHeader | null;
	anchor: {
		header: EpochHeader;
		nodes: readonly ReplayNode[];
		usage: TokenUsage;
	} | null;
	logRevision: SessionLogOffset;
}
