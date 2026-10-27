import { createHash } from "node:crypto";
import type {
	LlmImageRequestPrice,
	LlmImageRequestPricing,
	default as LlmService,
	Message,
	TokenUsage,
} from "@deepseek-ai/dsh-llm";
import type { EpochHeader, SessionEvent } from "@deepseek-ai/dsh-session";
import { SessionLogOffset } from "@deepseek-ai/dsh-session";
import type { TokenMeasurementBaseline } from "@deepseek-ai/dsh-token-meter";
import type {
	MeterConfig,
	MeterEvent,
	ReplayHeader,
	ReplayNode,
	ReplayState,
} from "./types.js";
export interface MeterServices {
	llm?: Pick<LlmService, "imageRequestPricing" | "fileRequestText">;
}
interface Attachments {
	imagePricing?: LlmImageRequestPricing;
	fileText?: LlmService["fileRequestText"];
	imagePrices: readonly LlmImageRequestPrice[];
	imageCursor: number;
	unpricedImages: boolean;
	unpricedFiles: boolean;
}

import { lastAssistantStreamChunk } from "@deepseek-ai/dsh-llm";
import {
	canonicalHeader,
	deriveEventMessage,
	headerEquals,
	isSurfaceEvent,
} from "@deepseek-ai/dsh-session";
import { deepFreeze } from "@deepseek-ai/dsh-util-values";
import { countText, resolvePolicy } from "./tokenizers.js";

/** Tool schemas compare in order, identically for raw and summarized headers. */
export const headerToolsKey = (header: ReplayHeader) =>
	header.toolsKey ??
	createHash("sha256")
		.update(JSON.stringify(header.tools ?? []))
		.digest("hex");
function meterHeaderEquals(a: ReplayHeader, b: ReplayHeader) {
	return a.toolsKey || b.toolsKey
		? headerEquals({ ...a, tools: undefined }, { ...b, tools: undefined }) &&
				headerToolsKey(a) === headerToolsKey(b)
		: headerEquals(a, b);
}

export const initialState = (): ReplayState => ({
	nodes: [],
	header: null,
	anchor: null,
	logRevision: SessionLogOffset(0),
});

export function inputTokens(usage: TokenUsage) {
	return (
		usage.inputTokens +
		(usage.cacheReadTokens ?? 0) +
		(usage.cacheWriteTokens ?? 0)
	);
}

export function usageOf(
	event: Extract<
		SessionEvent,
		{ type: "assistant/message" | "assistant/attempt" }
	>,
): TokenUsage | undefined {
	return event.type === "assistant/message" && event.data.usage !== undefined
		? event.data.usage
		: lastAssistantStreamChunk(event.data.stream, "usage")?.usage;
}

/** Custom counting state driven by the host projection registry. */
export function fold(state: ReplayState, event: MeterEvent): ReplayState {
	const next: ReplayState = {
		...state,
		logRevision: SessionLogOffset(event.seq + 1),
	};
	if (event.type === "llm/retry-started") return next;
	if (event.type === "request/header")
		next.header = canonicalHeader(event.data.header);
	// Failed attempts never calibrate occupancy. Zero samples are also ignored.
	if (event.type === "assistant/message") {
		const usage = usageOf(event);
		if (usage && inputTokens(usage) > 0 && next.header)
			next.anchor = {
				header: next.header,
				nodes: state.nodes,
				usage,
			};
	}
	if (event.type === "image/offload") {
		const targets = new Map(
			event.data.targets.map((t) => [t.seq, new Set(t.imageIndexes)]),
		);
		next.nodes = state.nodes.map((node) => {
			const indexes = targets.get(node.seq);
			if (!indexes || !node.message) return node;
			let index = 0;
			const content = node.message.content.map((block) =>
				block.type !== "image"
					? block
					: indexes.has(index++)
						? { ...block, offloaded: true as const }
						: block,
			);
			return { ...node, message: { ...node.message, content } };
		});
	}
	if (event.type === "image/offload") return next;
	if (isSurfaceEvent(event)) {
		const message = deriveEventMessage(event);
		const node = {
			seq: event.seq,
			message,
		};
		if (event.surfaceOp === "append") next.nodes = [...state.nodes, node];
		else {
			const { startSeq, endSeq } = event.surfaceOp;
			const start = state.nodes.findIndex((n) => n.seq === startSeq);
			const end = state.nodes.findIndex((n) => n.seq === endSeq);
			if (start < 0 || end < start)
				throw new Error(`Invalid surface replacement at seq ${event.seq}`);
			next.nodes = [
				...state.nodes.slice(0, start),
				node,
				...state.nodes.slice(end + 1),
			];
		}
	}
	return next;
}

export function contentTokens(
	blocks: Message["content"],
	policy: Pick<
		ReturnType<typeof resolvePolicy>,
		"tokenizer" | "includeReasoning"
	>,
	attachments: Attachments = {
		imagePrices: [],
		imageCursor: 0,
		unpricedImages: false,
		unpricedFiles: false,
	},
) {
	const count = (text: string) => countText(text, policy.tokenizer);
	let tokens = 0;
	for (const block of blocks) {
		switch (block.type) {
			case "text":
				tokens += count(block.text);
				break;
			case "reasoning":
				if (policy.includeReasoning) tokens += count(block.text);
				break;
			case "tool-call":
				tokens += count(block.name) + count(block.arguments);
				if (block.id) tokens += count(block.id);
				break;
			case "image": {
				if (attachments.imagePricing) {
					const price = attachments.imagePrices[attachments.imageCursor++];
					tokens += price.visualTokens + count(price.text);
				} else {
					// Reference tokenization is not a visual-token count; expose this in diagnostics.
					attachments.unpricedImages = true;
					tokens += count(JSON.stringify(block));
				}
				break;
			}
			case "file":
				if (attachments.fileText)
					tokens += count(attachments.fileText(block.attachment));
				else {
					attachments.unpricedFiles = true;
					tokens += count(JSON.stringify(block));
				}
				break;
			default:
				tokens += count(JSON.stringify(block));
		}
	}
	return tokens;
}

export function priceSurface(
	nodes: readonly ReplayNode[],
	header: ReplayHeader | null,
	config: MeterConfig,
	services: MeterServices,
) {
	const policy = resolvePolicy(config, header);
	const route = header?.config;
	const llm = services.llm;
	const attachments: Attachments = {
		imagePrices: [],
		imageCursor: 0,
		imagePricing:
			route && services.llm?.imageRequestPricing(route.provider, route.model),
		fileText: llm ? (ref) => llm.fileRequestText(ref) : undefined,
		unpricedImages: false,
		unpricedFiles: false,
	};
	const images = nodes.flatMap(
		(n) => n.message?.content.filter((b) => b.type === "image") ?? [],
	);
	attachments.imagePrices =
		attachments.imagePricing && images.length
			? attachments.imagePricing.priceImages(images)
			: [];
	if (
		attachments.imagePricing &&
		(attachments.imagePrices.length !== images.length ||
			attachments.imagePrices.some(
				(p) => !Number.isSafeInteger(p.visualTokens) || p.visualTokens < 0,
			))
	)
		throw new Error("Invalid route image pricing");
	const priced = nodes.map((node) => {
		const message = node.message;
		const counts = node.counts;
		const body =
			contentTokens(message?.content ?? [], policy, attachments) +
			(counts?.text[policy.tokenizer] ?? 0) +
			(policy.includeReasoning
				? (counts?.reasoning[policy.tokenizer] ?? 0)
				: 0);
		const envelope =
			counts?.envelope ||
			message?.content.some((b) => b.type === "text" || b.type === "tool-call");
		const tokens = body > 0 || envelope ? body + policy.tokensPerMessage : 0;
		// DSH 0.2.1-rc.2 compaction requires this field for shadowedTokenCount.
		return { seq: node.seq, tokens, heuristicTokens: tokens };
	});
	const surfaceTokens = priced.reduce((sum, node) => sum + node.tokens, 0);
	const toolsTokens = header?.toolCounts
		? header.toolCounts[policy.tokenizer] + policy.toolsOverhead
		: header?.tools?.length
			? countText(JSON.stringify(header.tools), policy.tokenizer) +
				policy.toolsOverhead
			: 0;
	const primingTokens = header || nodes.length ? policy.replyPrimingTokens : 0;
	return {
		nodes: priced,
		surfaceTokens,
		toolsTokens,
		primingTokens,
		requestTokens: surfaceTokens + toolsTokens + primingTokens,
		policy,
		unpricedImages: attachments.unpricedImages,
		unpricedFiles: attachments.unpricedFiles,
	};
}

/** Provider input calibrates request framing; retained assistant text is counted locally.
 * Output usage (which may include hidden reasoning) is never blindly added to the next input.
 */
export function measureState(
	state: ReplayState,
	config: MeterConfig,
	services: MeterServices = {},
	requestHeader?: EpochHeader,
) {
	const header: ReplayHeader | null =
		requestHeader === undefined ? state.header : canonicalHeader(requestHeader);
	const current = priceSurface(state.nodes, header, config, services);
	const anchor = state.anchor;
	const reusable = anchor && header && meterHeaderEquals(anchor.header, header);
	let baseline: TokenMeasurementBaseline;
	let surfaceDeltaTokens = 0;
	if (reusable) {
		const previous = priceSurface(anchor.nodes, header, config, services);
		baseline = {
			kind: "usage",
			tokens: inputTokens(anchor.usage),
			usage: anchor.usage,
		};
		surfaceDeltaTokens = current.requestTokens - previous.requestTokens;
	} else
		baseline =
			!header && state.nodes.length === 0
				? { kind: "none", tokens: 0 }
				: { kind: "estimated", tokens: current.requestTokens };
	return deepFreeze({
		logRevision: state.logRevision,
		baseline,
		surfaceDeltaTokens,
		totalTokens: Math.max(0, baseline.tokens + surfaceDeltaTokens),
		surfaceTokens: current.surfaceTokens,
		toolsTokens: current.toolsTokens,
		nodes: current.nodes,
		tokenizer: current.policy.tokenizer,
		unpricedImages: current.unpricedImages,
		unpricedFiles: current.unpricedFiles,
	});
}
