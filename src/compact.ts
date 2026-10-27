import { createHash } from "node:crypto";
import type { EpochHeader } from "@deepseek-ai/dsh-session";
import { SessionLogOffset, SessionSeq } from "@deepseek-ai/dsh-session";
import type { FileBlock, ImageBlock, TokenUsage } from "@deepseek-ai/dsh-llm";
import { z } from "zod";
import { contentTokens, fold, headerToolsKey, initialState } from "./core.js";
import { deepFreeze } from "@deepseek-ai/dsh-util-values";
import { countText, tokenizerGeneration } from "./tokenizers.js";
import type {
	MeterConfig,
	MeterEvent,
	ReplayHeader,
	ReplayNode,
} from "./types.js";
export { measureState as measureCompact } from "./core.js";

const count = z.number().int().nonnegative();
const counts = z.record(z.string(), count);
const nodeSchema = z.object({
	seq: count.transform(SessionSeq),
	system: z.boolean(),
	counts: z.object({ text: counts, reasoning: counts, envelope: z.boolean() }),
	// Only durable attachment references survive; never text or tool-call bodies.
	message: z
		.object({ content: z.array(z.custom<ImageBlock | FileBlock>()) })
		.nullable(),
	heuristicTokens: count.optional(),
});
const headerSchema = z.object({
	config: z.custom<EpochHeader["config"]>(),
	adapterDefaults: z.custom<EpochHeader["adapterDefaults"]>().optional(),
	toolsKey: z.string(),
	toolCounts: counts.nullable(),
});
export const compactSchema = z.object({
	nodes: z.array(nodeSchema),
	header: headerSchema.nullable(),
	anchor: z
		.object({
			header: headerSchema,
			nodes: z.array(nodeSchema),
			usage: z.custom<TokenUsage>(),
		})
		.nullable(),
	logRevision: count.transform(SessionLogOffset),
});
export type CompactState = z.infer<typeof compactSchema>;
export const initialCompactState = () => initialState() as CompactState;

/** Counts cannot be reused across schema or policy changes. */
export function compactVersion(config: MeterConfig) {
	const hash = createHash("sha256")
		.update(JSON.stringify([2, config]))
		.digest("hex");
	return 0x100000000 + Number.parseInt(hash.slice(0, 8), 16);
}
function tokenizerNames(config: MeterConfig) {
	return [
		...new Set([
			config.defaultTokenizer,
			...[...(config.providerPolicies ?? []), ...config.modelPolicies].flatMap(
				(p) => (p.tokenizer === undefined ? [] : [p.tokenizer]),
			),
		]),
	];
}
interface PayloadCounts {
	header?: Pick<NonNullable<CompactState["header"]>, "toolsKey" | "toolCounts">;
	node?: CompactState["nodes"][number]["counts"];
}
// The host cold-replays one whole projection at a time. A bounded text cache
// cannot bridge those passes. Share only immutable numeric payload summaries:
// never a fold state, body, tool schema, attachment, or strong event reference.
let payloads = new WeakMap<MeterEvent, Map<string, PayloadCounts>>();
let payloadGeneration = -1;
function payloadCounts(event: MeterEvent, config: MeterConfig): PayloadCounts {
	const generation = tokenizerGeneration();
	if (generation !== payloadGeneration) {
		payloads = new WeakMap();
		payloadGeneration = generation;
	}
	let policies = payloads.get(event);
	if (!policies) {
		policies = new Map();
		payloads.set(event, policies);
	}
	// Overheads and route/reasoning selection do not affect these base counts.
	const key = JSON.stringify(tokenizerNames(config));
	let summary = policies.get(key);
	if (!summary) {
		summary = {};
		policies.set(key, summary);
	}
	return summary;
}
function compactHeader(
	header: ReplayHeader,
	config: MeterConfig,
	memo: PayloadCounts,
) {
	if (!memo.header) {
		const tools = header.tools?.length ? JSON.stringify(header.tools) : null;
		memo.header = deepFreeze({
			toolsKey: headerToolsKey(header),
			toolCounts:
				tools === null
					? null
					: Object.fromEntries(
							tokenizerNames(config).map((name) => [
								name,
								countText(tools, name),
							]),
						),
		});
	}
	return {
		config: header.config,
		...(header.adapterDefaults
			? { adapterDefaults: header.adapterDefaults }
			: {}),
		...memo.header,
	};
}
function compactNode(
	node: ReplayNode,
	system: boolean,
	config: MeterConfig,
	memo: PayloadCounts,
): CompactState["nodes"][number] {
	const content = node.message?.content ?? [];
	const attachments = content.filter(
		(b): b is ImageBlock | FileBlock => b.type === "image" || b.type === "file",
	);
	if (!memo.node) {
		const text = content.filter((b) => b.type !== "image" && b.type !== "file");
		const names = tokenizerNames(config);
		const prices = (blocks: typeof content, includeReasoning: boolean) =>
			Object.fromEntries(
				names.map((tokenizer) => [
					tokenizer,
					contentTokens(blocks, { tokenizer, includeReasoning }),
				]),
			);
		memo.node = deepFreeze({
			text: prices(text, false),
			reasoning: prices(
				text.filter((b) => b.type === "reasoning"),
				true,
			),
			envelope: text.some((b) => b.type === "text" || b.type === "tool-call"),
		});
	}
	return {
		seq: node.seq,
		system,
		counts: memo.node,
		message: attachments.length ? { content: attachments } : null,
	};
}

/** The existing fold owns usage, offload and replacement semantics; only its new payloads are summarized. */
export function foldCompact(
	state: CompactState,
	event: MeterEvent,
	config: MeterConfig,
): CompactState {
	const next = fold(state, event);
	return {
		...next,
		header:
			next.header === state.header
				? state.header
				: next.header &&
					compactHeader(next.header, config, payloadCounts(event, config)),
		nodes:
			next.nodes === state.nodes
				? state.nodes
				: next.nodes.map((node) =>
						node.counts
							? node
							: compactNode(
									node,
									event.type === "system/message",
									config,
									payloadCounts(event, config),
								),
					),
	} as CompactState;
}
