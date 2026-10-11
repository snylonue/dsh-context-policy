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

export interface ModelPolicy {
	provider?: string;
	model: string;
	tokenizer: string;
	tokensPerMessage?: number;
	toolsOverhead?: number;
	replyPrimingTokens?: number;
	includeReasoning?: boolean;
}
export interface MeterConfigInput {
	defaultTokenizer?: string;
	modelPolicies?: (Omit<ModelPolicy, "tokenizer"> & { tokenizer?: string })[];
}
export interface MeterConfig {
	defaultTokenizer: string;
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
