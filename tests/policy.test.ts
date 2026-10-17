import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import Registry from "@deepseek-ai/dsh-session-projection";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionLogOffset, SessionSeq } from "@deepseek-ai/dsh-session";
import type {
	Session,
	SessionEvent,
	EpochHeader,
} from "@deepseek-ai/dsh-session";
import type {
	BasicCompactionConfig,
	ResolvedTargetPolicy,
} from "@deepseek-ai/dsh-compaction-basic";
import Meter from "../dist/token-meter.js";
import Compaction, {
	resolveCompactSpec,
	selectCompactableRange,
} from "../dist/compaction.js";
import {
	countText,
	resolvePolicy,
	registerTokenizer,
} from "../dist/tokenizers.js";
import { initialState, fold, measureState } from "../dist/core.js";
import { createDisplayProjections, replayProjection } from "../dist/projection.js";

const meterConfig = { defaultTokenizer: "o200k_base", modelPolicies: [] };
const header = (provider = "p", model = "gpt-new", maxTokens = 128000) =>
	({ config: { provider, model, maxTokens }, tools: [] }) as EpochHeader;
function event(
	seq: number,
	type: string,
	data: unknown,
	surfaceOp?: unknown,
): SessionEvent {
	return {
		seq: SessionSeq(seq),
		type,
		data,
		...(surfaceOp === undefined ? {} : { surfaceOp }),
	} as SessionEvent;
}
function user(seq: number, text: string, op: unknown = "append") {
	return event(
		seq,
		"user/message",
		createUserMessage({
			source: { kind: "user" },
			content: [{ type: "text", text }],
		}),
		op,
	);
}
function assistant(seq: number, usage: unknown, text = "ok", step = 0) {
	return event(
		seq,
		"assistant/message",
		{
			turn: 0,
			step,
			message: {
				id: `a${seq}`,
				role: "assistant",
				content: [{ type: "text", text }],
			},
			stream: [],
			usage,
		},
		"append",
	);
}
function session(events: SessionEvent[]) {
	const state = events.reduce(fold, initialState());
	return {
		seq: events.length,
		header: {},
		inheritedEventCount: 0,
		snapshotEvents: () => events.slice(),
		eventAt: (seq: number) => events[seq],
		requestHeader: () => state.header ?? undefined,
		surface: { nodes: state.nodes.map((n) => n.seq), replaceGeneration: 0 },
	} as unknown as Session;
}
const policy: ResolvedTargetPolicy = {
	target: { provider: "p", model: "m" },
	thresholdRatio: 0.9,
	headroomTokens: 65536,
	retainRatio: 0.16,
	summarizationProvider: "",
	summarizationModel: "",
	maxTokens: 8192,
	compactionRetries: 1,
	maxOverflowRetries: 1,
};

test("percentage trigger ignores output/headroom and scales retention against full window", () => {
	for (const maxTokens of [1, 8192, 128000]) {
		const spec = resolveCompactSpec(
			{ ...policy, maxTokens, headroomTokens: 999999 },
			272000,
		);
		assert.equal(spec.thresholdTokens, 244800);
		assert.equal(spec.retainTokens, 43520);
	}
	assert.throws(() =>
		resolveCompactSpec({ ...policy, retainRatio: 0.95 }, 272000),
	);
	assert.throws(() => resolveCompactSpec(policy, 0));
});

test("o200k_base counts ordinary text; exact provider mapping wins", () => {
	assert.equal(countText("hello world", "o200k_base"), 2);
	assert.equal(countText("你好世界", "o200k_base"), 2);
	assert.equal(countText("<|endoftext|>", "o200k_base"), 7);
	assert.throws(() => countText("x", "cl100k_base"));
	const unregister = registerTokenizer("custom-test", (text) => text.length);
	const cfg = {
		defaultTokenizer: "o200k_base",
		modelPolicies: [
			{ model: "m", tokenizer: "o200k_base", tokensPerMessage: 9 },
			{
				provider: "p",
				model: "m",
				tokenizer: "custom-test",
				tokensPerMessage: 7,
			},
		],
	};
	assert.equal(resolvePolicy(cfg, header("p", "m")).tokenizer, "custom-test");
	assert.equal(resolvePolicy(cfg, header("q", "m")).tokensPerMessage, 9);
	assert.equal(countText("hello", "custom-test"), 5);
	unregister();
	assert.throws(() => countText("hello", "custom-test"));
});

test("DeepSeek V4 model policies reprice measurement and preserve the default route", () => {
	const cfg = Meter.Config({
		modelPolicies: [
			{ model: "deepseek-v4-pro", tokenizer: "deepseek_v4" },
			{ model: "deepseek-v4-flash", tokenizer: "deepseek_v4" },
		],
	});
	for (const model of ["deepseek-v4-pro", "deepseek-v4-flash"]) {
		const state = [
			event(0, "request/header", { header: header("deepseek", model) }),
			user(1, "你好世界"),
		].reduce(fold, initialState());
		const measurement = measureState(state, cfg);
		assert.equal(measurement.tokenizer, "deepseek_v4");
		assert.equal(measurement.surfaceTokens, 5); // 2 text + 3 message
		assert.equal(measurement.totalTokens, 8); // + 3 reply
	}
	assert.equal(resolvePolicy(cfg, header()).tokenizer, "deepseek_v4");
});

test("DeepSeek V4 is the global default; provider defaults price every model on that provider", () => {
	const defaults = Meter.Config({});
	assert.equal(defaults.defaultTokenizer, "deepseek_v4");
	assert.deepEqual(defaults.providerPolicies, []);
	assert.equal(resolvePolicy(defaults, null).tokenizer, "deepseek_v4");
	const cfg = Meter.Config({ providerPolicies: [{ provider: "openai", tokenizer: "o200k_base" }] });
	for (const [provider, model, tokenizer, tokens] of [
		["openai", "new-model", "o200k_base", 13],
		["openai", "other-model", "o200k_base", 13],
		["other", "new-model", "deepseek_v4", 14],
	] as const) {
		const state = [
			event(0, "request/header", { header: header(provider, model) }),
			user(1, "DeepSeek V4 Pro / Flash"),
		].reduce(fold, initialState());
		const measurement = measureState(state, cfg);
		assert.equal(measurement.tokenizer, tokenizer);
		assert.equal(measurement.totalTokens, tokens);
	}
	const customDefault = Meter.Config({ defaultTokenizer: "o200k_base" });
	assert.equal(resolvePolicy(customDefault, null).tokenizer, "o200k_base");
});

test("matched model policy overrides the provider tokenizer, or inherits it when omitted", () => {
	const cfg = Meter.Config({
		providerPolicies: [
			{ provider: "openai", tokenizer: "o200k_base" },
			{ provider: "another", tokenizer: "o200k_base" },
		],
		modelPolicies: [
			{ model: "shared", tokenizer: "deepseek_v4" },
			{
				provider: "openai",
				model: "shared",
				tokenizer: "o200k_base",
				tokensPerMessage: 7,
			},
			{ model: "framing", tokensPerMessage: 9 },
			{ provider: "openai", model: "exact-inherit", tokensPerMessage: 11 },
		],
	});
	const exact = resolvePolicy(cfg, header("openai", "shared"));
	assert.equal(exact.tokenizer, "o200k_base");
	assert.equal(exact.tokensPerMessage, 7);
	assert.equal(
		resolvePolicy(cfg, header("another", "shared")).tokenizer,
		"deepseek_v4",
	);
	const inherited = resolvePolicy(cfg, header("openai", "framing"));
	assert.equal(inherited.tokenizer, "o200k_base");
	assert.equal(inherited.tokensPerMessage, 9);
	assert.equal(
		resolvePolicy(cfg, header("other", "framing")).tokenizer,
		"deepseek_v4",
	);
	const exactInherited = resolvePolicy(cfg, header("openai", "exact-inherit"));
	assert.equal(exactInherited.tokenizer, "o200k_base");
	assert.equal(exactInherited.tokensPerMessage, 11);
});

test("calibrate prompt plus cache traffic; never add hidden reasoning output blindly", () => {
	const events = [
		event(0, "request/header", { header: header() }),
		event(1, "request/context", { contextWindow: 272000 }),
		user(2, "question"),
		assistant(3, {
			inputTokens: 80,
			cacheReadTokens: 15,
			cacheWriteTokens: 5,
			outputTokens: 9000,
		}),
	];
	const state = events.reduce(fold, initialState());
	const m = measureState(state, meterConfig);
	assert.equal(m.baseline.tokens, 100);
	const last = m.nodes.at(-1);
	assert(last);
	assert.equal(m.totalTokens, 100 + last.tokens);
	assert(m.totalTokens < 9000);
	assert.equal(m.logRevision, events.length);
	assert(Object.isFrozen(m));
	assert(Object.isFrozen(m.nodes));
});

test("failure with zero usage preserves occupancy; retries still accumulate billed usage", async () => {
	let state = [
		event(0, "request/header", { header: header() }),
		user(1, "question"),
		assistant(2, { inputTokens: 120, outputTokens: 10 }),
	].reduce(fold, initialState());
	const before = measureState(state, meterConfig);
	const attempt = event(3, "assistant/attempt", {
		turn: 0,
		step: 1,
		stream: [
			{
				type: "chunk",
				chunk: { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } },
			},
		],
	});
	state = fold(state, attempt);
	assert.equal(
		measureState(state, meterConfig).totalTokens,
		before.totalTokens,
	);
	assert.equal(measureState(state, meterConfig).baseline.tokens, 120);
	const failed = event(0, "assistant/attempt", {
		turn: 0,
		step: 0,
		stream: [
			{
				type: "chunk",
				chunk: { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } },
			},
		],
	});
	const ctx = new Context();
	await ctx.plugin(Registry).await();
	await ctx.plugin(Meter, {}).await();
	try {
		const events = [
			failed,
			event(1, "llm/retry-started", { turn: 0, step: 0 }),
			assistant(2, { inputTokens: 20, outputTokens: 3 }),
		];
		const s = session(events);
		const billing = ctx.sessionProjections.snapshot(s).values.tokenUsage;
		assert(billing);
		assert.equal(billing.uncachedInputTokens, 30);
		assert.equal(billing.outputTokens, 5);
		events.push(assistant(3, { inputTokens: 20, outputTokens: 3 }));
		Object.assign(s, { seq: events.length });
		assert.deepEqual(
			ctx.sessionProjections.snapshot(s).values.tokenUsage,
			billing,
		);
	} finally {
		await ctx.fiber.dispose();
	}
});

test("replacement reprices removed content and uses model counts for durable shadow prices", () => {
	let state = [
		event(0, "request/header", { header: header() }),
		user(1, "long ".repeat(600)),
		assistant(2, { inputTokens: 2000, outputTokens: 2 }),
	].reduce(fold, initialState());
	const before = measureState(state, meterConfig);
	const originalMessage = state.nodes[0].message;
	assert(state.nodes.every((node) => !("heuristicTokens" in node)));
	assert(before.nodes.every((node) => node.heuristicTokens === node.tokens));
	state = fold(
		state,
		user(3, "summary", { startSeq: SessionSeq(1), endSeq: SessionSeq(1) }),
	);
	const after = measureState(state, meterConfig);
	assert(after.totalTokens < before.totalTokens);
	assert(after.surfaceDeltaTokens < 0);
	assert.deepEqual(
		after.nodes.map((n) => n.seq),
		[3, 2],
	);
	assert(state.anchor);
	assert.equal(state.anchor.nodes[0].message, originalMessage);
	assert(after.nodes.every((node) => node.heuristicTokens === node.tokens));
	assert(state.nodes.every((node) => !("heuristicTokens" in node)));
});

test("header/model changes reject old usage anchor and reprice using mapped tokenizer", () => {
	const unregister = registerTokenizer("characters", (text) => text.length);
	let state = [
		event(0, "request/header", { header: header() }),
		user(1, "hello world"),
		assistant(2, { inputTokens: 800, outputTokens: 2 }),
	].reduce(fold, initialState());
	state = fold(
		state,
		event(3, "request/header", { header: header("other", "char-model") }),
	);
	const m = measureState(state, {
		defaultTokenizer: "o200k_base",
		modelPolicies: [
			{ provider: "other", model: "char-model", tokenizer: "characters" },
		],
	});
	assert.equal(m.baseline.kind, "estimated");
	assert.equal(m.tokenizer, "characters");
	assert(m.totalTokens < 800);
	unregister();
});

test("batch image pricing and adapter file projection; image offload retains anchor accounting", () => {
	const base = createUserMessage({
		source: { kind: "user" },
		content: [{ type: "text", text: "question" }],
	});
	const message = { ...base, content: [...base.content] };
	message.content.push(
		{ type: "image", image: "one" } as never,
		{ type: "image", image: "two" } as never,
		{ type: "file", attachment: { id: "f" } } as never,
	);
	let state = [
		event(0, "request/header", { header: header() }),
		event(1, "user/message", message, "append"),
	].reduce(fold, initialState());
	const batches: number[] = [];
	const services = {
		llm: {
			imageRequestPricing: () => ({
				priceImages: (images: readonly { offloaded?: boolean }[]) => {
					batches.push(images.length);
					return images.map((i, index) => ({
						visualTokens: i.offloaded ? 0 : 100 + index,
						text: "image",
					}));
				},
			}),
			fileRequestText: () => "file text",
		},
	};
	const before = measureState(state, meterConfig, services);
	assert.deepEqual(batches, [2]);
	assert.equal(before.unpricedImages, false);
	assert.equal(before.unpricedFiles, false);
	state = fold(state, {
		type: "image/offload",
		seq: SessionSeq(2),
		data: { targets: [{ seq: SessionSeq(1), imageIndexes: [0] }] },
	});
	assert.equal(
		before.totalTokens - measureState(state, meterConfig, services).totalTokens,
		100,
	);
	assert.equal(measureState(state, meterConfig).unpricedImages, true);
	assert.equal(measureState(state, meterConfig).unpricedFiles, true);
	assert.throws(() =>
		measureState(state, meterConfig, {
			llm: {
				...services.llm,
				imageRequestPricing: () => ({ priceImages: () => [] }),
			},
		}),
	);
});

test("actual Cordis registry replays nonempty logs, validates all UI views and unloads cleanly", async () => {
	const ctx = new Context();
	await ctx.plugin(Registry).await();
	const fiber = ctx.plugin(Meter, {});
	await fiber.await();
	try {
		const events = [
			event(0, "request/header", { header: header() }),
			event(1, "request/context", { contextWindow: 272000 }),
			user(2, "hello world"),
			assistant(3, { inputTokens: 100, outputTokens: 2 }),
		];
		const s = session(events);
		const actual = ctx.tokenMeter.measure(s);
		assert.equal(actual.baseline.kind, "usage");
		const values = ctx.sessionProjections.snapshot(s).values;
		assert.deepEqual(Object.keys(values).sort(), [
			"contextBreakdown",
			"contextPressure",
			"tokenUsage",
		]);
		assert.equal(values.contextPressure?.projectedTokens, actual.totalTokens);
		assert.equal(values.contextPressure?.pressureTokens, 100);
		assert(ctx.sessionProjections.stateOf(s, "contextPolicyMeter"));
		assert.equal(
			ctx.sessionProjections.stateOf(s, "contextPressure")?.surfaceTokens,
			actual.surfaceTokens,
		);
		assert.deepEqual(
			ctx.sessionProjections.stateOf(s, "contextBreakdown")?.breakdown,
			values.contextBreakdown,
		);
		assert.equal(values.tokenUsage?.uncachedInputTokens, 100);
		const checkpoint = ctx.sessionProjections.checkpoint(s);
		assert.deepEqual(ctx.sessionProjections.viewCheckpoint(checkpoint), values);
		await fiber.dispose();
		assert.deepEqual(ctx.sessionProjections.snapshot(s).values, {});
		const reloaded = ctx.plugin(
			Meter,
			Meter.Config({
				modelPolicies: [
					{ provider: "p", model: "gpt-new", tokensPerMessage: 1000 },
				],
			}),
		);
		await reloaded.await();
		const updated = ctx.sessionProjections.snapshot(s).values;
		assert.deepEqual(updated.tokenUsage, values.tokenUsage);
		assert.equal(
			updated.contextPressure?.contextWindow,
			values.contextPressure?.contextWindow,
		);
		assert.equal(
			updated.contextPressure?.projectedTokens,
			ctx.tokenMeter.measure(s).totalTokens,
		);
		assert(ctx.tokenMeter.measure(s).totalTokens > actual.totalTokens);
		assert(updated.contextBreakdown && values.contextBreakdown);
		assert(
			updated.contextBreakdown.messageTokens >
				values.contextBreakdown.messageTokens,
		);
		assert.deepEqual(
			ctx.sessionProjections.viewCheckpoint(checkpoint),
			updated,
		);
		const restored = ctx.sessionProjections.restore(
			checkpoint,
			events.slice(-1),
			SessionLogOffset(events.length - 1),
			s.header,
			SessionLogOffset(0),
		);
		assert.deepEqual(restored.snapshot.values, updated);
	} finally {
		await ctx.fiber.dispose();
	}
});

test("display state and serialized checkpoints use model prices across route and surface changes", () => {
	const cfg = Meter.Config({
		defaultTokenizer: "o200k_base",
		modelPolicies: [
			{ provider: "p", model: "gpt-new", tokensPerMessage: 31, toolsOverhead: 17 },
			{ provider: "p", model: "other", tokenizer: "deepseek_v4", tokensPerMessage: 43 },
		],
	});
	const services = {
		llm: {
			imageRequestPricing: () => ({
				priceImages: (images: readonly { offloaded?: boolean }[]) =>
					images.map((image) => ({ visualTokens: image.offloaded ? 0 : 123, text: "image" })),
			}),
			fileRequestText: () => "rendered file text",
		},
	};
	const display = createDisplayProjections(cfg, services);
	let pressure = display.pressure.init();
	let breakdown = display.breakdown.init();
	let replay = initialState();
	const withTools = { ...header(), tools: [{ name: "tool", description: "description", parameters: { type: "object" } }] };
	const events = [
		event(0, "system/message", { message: { role: "system", content: [{ type: "text", text: "system instructions" }] } }, "append"),
		event(1, "user/message", createUserMessage({ source: { kind: "user" }, content: [
			{ type: "text", text: "你好世界" },
			{ type: "image", image: "image" } as never,
			{ type: "file", attachment: { id: "file" } } as never,
		] }), "append"),
		event(2, "request/header", { header: withTools }),
		event(3, "request/context", { contextWindow: 272000 }),
		assistant(4, { inputTokens: 300, outputTokens: 2 }),
		event(5, "request/header", { header: { ...withTools, config: header("p", "other").config } }),
		event(6, "image/offload", { targets: [{ seq: SessionSeq(1), imageIndexes: [0] }] }),
		user(7, "replacement", { startSeq: SessionSeq(1), endSeq: SessionSeq(1) }),
		event(8, "system/message", { message: { role: "system", content: [] } }, { startSeq: SessionSeq(0), endSeq: SessionSeq(0) }),
	];
	for (const next of events) {
		replay = fold(replay, next);
		pressure = display.pressure.apply(pressure, next);
		breakdown = display.breakdown.apply(breakdown, next);
		const measurement = measureState(replay, cfg, services);
		for (const [definition, state] of [[display.pressure, pressure], [display.breakdown, breakdown]] as const) {
			assert.equal(state.surfaceTokens, measurement.surfaceTokens);
			assert.deepEqual(state.nodes.map((node) => node.heuristicTokens), measurement.nodes.map((node) => node.tokens));
			assert.deepEqual(state.breakdown, display.breakdown.wire.view(breakdown));
			assert.equal(state.breakdown.toolsTokens, measurement.toolsTokens);
			const restored = definition.stateSchema.parse(JSON.parse(JSON.stringify(state)));
			assert.deepEqual(restored, state);
			assert.deepEqual(definition.wire.view(restored), definition.wire.view(state));
		}
		assert.equal(display.pressure.wire.view(pressure).projectedTokens, measurement.totalTokens);
		assert(replay.nodes.every((node) => !("heuristicTokens" in node)));
	}
	assert.equal(breakdown.breakdown.systemTokens, 0);
	assert(display.pressure.stateVersion > 7);
	assert(replayProjection.stateVersion > 1);
});

test("display projections retain ordered system prices across routes and replacements", () => {
	const cfg = Meter.Config({
		defaultTokenizer: "o200k_base",
		modelPolicies: [{ provider: "p", model: "other", tokensPerMessage: 37 }],
	});
	const display = createDisplayProjections(cfg, {});
	let pressure = display.pressure.init();
	let breakdown = display.breakdown.init();
	let replay = initialState();
	assert.deepEqual(breakdown.systems, []);
	const events = [
		event(
			0,
			"system/message",
			{
				message: {
					role: "system",
					content: [{ type: "text", text: "first system" }],
				},
			},
			"append",
		),
		event(
			1,
			"system/message",
			{
				message: {
					role: "system",
					content: [{ type: "text", text: "second system" }],
				},
			},
			"append",
		),
		event(
			2,
			"system/message",
			{ message: { role: "system", content: [] } },
			"append",
		),
		event(3, "request/header", { header: header() }),
		event(4, "request/header", { header: header("p", "other") }),
		event(
			5,
			"system/message",
			{
				message: {
					role: "system",
					content: [{ type: "text", text: "rewritten first" }],
				},
			},
			{ startSeq: SessionSeq(0), endSeq: SessionSeq(0) },
		),
		user(6, "tail"),
		user(7, "summary", { startSeq: SessionSeq(1), endSeq: SessionSeq(6) }),
		event(
			8,
			"system/message",
			{ message: { role: "system", content: [] } },
			{ startSeq: SessionSeq(5), endSeq: SessionSeq(5) },
		),
	];
	const expectedSeqs = [
		[0],
		[0, 1],
		[0, 1, 2],
		[0, 1, 2],
		[0, 1, 2],
		[5, 1, 2],
		[5, 1, 2],
		[5],
		[8],
	];
	for (const next of events) {
		replay = fold(replay, next);
		pressure = display.pressure.apply(pressure, next);
		breakdown = display.breakdown.apply(breakdown, next);
		const measurement = measureState(replay, cfg);
		const systems = expectedSeqs[next.seq].map((seq) => {
			const node = measurement.nodes.find((node) => node.seq === seq);
			assert(node);
			return { seq: SessionSeq(seq), tokens: node.tokens };
		});
		for (const [definition, state] of [
			[display.pressure, pressure],
			[display.breakdown, breakdown],
		] as const) {
			assert.deepEqual(state.systems, systems);
			assert.equal(
				state.breakdown.systemTokens,
				systems.findLast((node) => node.tokens > 0)?.tokens ?? 0,
			);
			assert.equal(
				state.breakdown.messageTokens + state.breakdown.systemTokens,
				measurement.surfaceTokens,
			);
			assert.deepEqual(
				definition.stateSchema.parse(JSON.parse(JSON.stringify(state))),
				state,
			);
			const { systems: _systems, ...legacy } = state;
			assert.equal(definition.stateSchema.safeParse(legacy).success, false);
		}
		if (next.seq === 5)
			assert.deepEqual(
				breakdown.systems.map((node) => node.seq),
				[5, 1, 2],
			);
		if (next.seq === 7)
			assert.deepEqual(
				breakdown.systems.map((node) => node.seq),
				[5],
			);
	}
	assert.deepEqual(breakdown.systems, [{ seq: SessionSeq(8), tokens: 0 }]);
	assert.equal(display.breakdown.wire.view(breakdown).systemTokens, 0);
	assert(display.breakdown.stateVersion > 8);
});

test("pre-systems display checkpoints rebuild and continue replay with current system prices", async () => {
	const ctx = new Context();
	await ctx.plugin(Registry).await();
	await ctx
		.plugin(Meter, Meter.Config({ defaultTokenizer: "o200k_base" }))
		.await();
	try {
		const events = [
			event(0, "request/header", { header: header() }),
			event(
				1,
				"system/message",
				{
					message: {
						role: "system",
						content: [{ type: "text", text: "instructions" }],
					},
				},
				"append",
			),
			user(2, "hello"),
		];
		const s = session(events);
		const checkpoint = structuredClone(ctx.sessionProjections.checkpoint(s));
		for (const key of ["contextPressure", "contextBreakdown"] as const) {
			const row = checkpoint[key];
			assert(row);
			row.ver = 8;
			assert(row.val !== null && typeof row.val === "object");
			Reflect.deleteProperty(row.val, "systems");
		}
		const cached = ctx.sessionProjections.viewCheckpoint(checkpoint);
		assert.equal(cached.contextPressure, undefined);
		assert.equal(cached.contextBreakdown, undefined);
		assert.equal(ctx.sessionProjections.restoreFloor(checkpoint), 0);
		const rebuilt = ctx.sessionProjections.restore(
			checkpoint,
			events,
			SessionLogOffset(0),
			s.header,
			SessionLogOffset(0),
		);
		assert.deepEqual(
			rebuilt.snapshot.values,
			ctx.sessionProjections.snapshot(s).values,
		);
		const expected = ctx.sessionProjections.stateOf(s, "contextBreakdown");
		assert(expected);
		assert.deepEqual(rebuilt.checkpoint.contextBreakdown?.val, expected);
		const tail = [
			event(
				3,
				"system/message",
				{
					message: {
						role: "system",
						content: [{ type: "text", text: "new instructions" }],
					},
				},
				{ startSeq: SessionSeq(1), endSeq: SessionSeq(1) },
			),
		];
		const continued = ctx.sessionProjections.restore(
			rebuilt.checkpoint,
			tail,
			SessionLogOffset(3),
			s.header,
			SessionLogOffset(0),
		);
		const complete = session([...events, ...tail]);
		assert.deepEqual(
			continued.snapshot.values,
			ctx.sessionProjections.snapshot(complete).values,
		);
		assert.deepEqual(
			continued.checkpoint.contextBreakdown?.val,
			ctx.sessionProjections.stateOf(complete, "contextBreakdown"),
		);
	} finally {
		await ctx.fiber.dispose();
	}
});

test("old heuristic checkpoints are invalidated and rebuilt from the log", async () => {
	const ctx = new Context();
	await ctx.plugin(Registry).await();
	await ctx.plugin(Meter, Meter.Config({ defaultTokenizer: "o200k_base" })).await();
	try {
		const events = [event(0, "request/header", { header: header() }), user(1, "你好世界")];
		const s = session(events);
		const checkpoint = structuredClone(ctx.sessionProjections.checkpoint(s));
		for (const key of ["contextPressure", "contextBreakdown", "contextPolicyMeter"] as const) {
			const row = checkpoint[key];
			assert(row);
			row.ver = key === "contextPolicyMeter" ? 1 : 7;
			Object.assign(row.val as object, { surfaceTokens: 99999, breakdown: { systemTokens: 99999, toolsTokens: 99999, messageTokens: 99999 } });
		}
		const cached = ctx.sessionProjections.viewCheckpoint(checkpoint);
		assert.equal(cached.contextPressure, undefined);
		assert.equal(cached.contextBreakdown, undefined);
		assert.equal(ctx.sessionProjections.restoreFloor(checkpoint), 0);
		const restored = ctx.sessionProjections.restore(checkpoint, events, SessionLogOffset(0), s.header, SessionLogOffset(0));
		assert.deepEqual(restored.snapshot.values, ctx.sessionProjections.snapshot(s).values);
		const state = restored.checkpoint.contextPressure?.val as { surfaceTokens: number; breakdown: unknown };
		assert.equal(state.surfaceTokens, ctx.tokenMeter.measure(s).surfaceTokens);
		assert.deepEqual(state.breakdown, restored.snapshot.values.contextBreakdown);
	} finally {
		await ctx.fiber.dispose();
	}
});

test("default 80% boundary triggers, independent of request output limits; pruner can avert compaction", async () => {
	const ctx = new Context();
	await ctx.plugin(Registry).await();
	let tokens = 217599,
		calls = 0;
	const s = session([
		event(0, "request/header", { header: header() }),
		user(1, "past"),
		user(2, "tail"),
	]);
	ctx.provide("llm");
	ctx.provide("tokenMeter");
	ctx.provide("toolResultPruner");
	ctx.set("llm", {
		resolveModelInfo: async () => ({
			context: { contextWindow: 272000 },
			defaultMaxTokens: 128000,
		}),
	} as never);
	ctx.set("tokenMeter", {
		measure: () => ({
			logRevision: 3,
			totalTokens: tokens,
			nodes: [
				{ seq: 1, tokens: 200000, heuristicTokens: 2 },
				{ seq: 2, tokens: 100000, heuristicTokens: 2 },
			],
		}),
	} as never);
	class TestCompaction extends Compaction {
		override async compactRegion() {
			calls++;
			tokens = 10000;
			return { test: true } as never;
		}
	}
	const engine = new TestCompaction(
		ctx,
		Compaction.Config({ auto: false }),
	);
	const agent = { session: s } as Parameters<Compaction["compactIfNeeded"]>[0];
	try {
		assert.equal(engine.config.thresholdRatio, 0.8);
		assert.equal(engine.config.retainRatio, 0.16);
		assert.equal(engine.config.maxTokens, 65536);
		assert.equal(await engine.compactIfNeeded(agent, "pressure"), null);
		assert.equal(calls, 0);
		tokens = 217600;
		await engine.compactIfNeeded(agent, "pressure");
		assert.equal(calls, 1);
		ctx.set("toolResultPruner", {
			pruneSession: () => {
				tokens = 100;
			},
		} as never);
		tokens = 250000;
		assert.equal(await engine.compactIfNeeded(agent, "pressure"), null);
		assert.equal(calls, 1);
	} finally {
		await ctx.fiber.dispose();
	}
});

test("model overrides inherit absent fields, support exact routes and ignore legacy headroom", async () => {
	for (const config of [
		{
			modelPolicies: [
				{
					provider: "p",
					model: "gpt-new",
					retainTokens: 20000,
					thresholdRatio: undefined,
					headroomTokens: 999999,
				},
			],
		},
		{
			thresholdRatio: 0.5,
			modelPolicies: [
				{ provider: "other", model: "gpt-new", thresholdRatio: 0.9 },
			],
		},
		{
			modelPolicies: [
				{
					provider: "p",
					model: "gpt-new",
					thresholdRatio: 0.5,
					retainTokens: 20000,
				},
			],
		},
	] satisfies BasicCompactionConfig[]) {
		const ctx = new Context();
		await ctx.plugin(Registry).await();
		ctx.provide("llm");
		ctx.provide("tokenMeter");
		const s = session([
			event(0, "request/header", { header: header() }),
			user(1, "past"),
			user(2, "tail"),
		]);
		let tokens =
			config.modelPolicies[0]?.thresholdRatio === undefined &&
			config.thresholdRatio === undefined
				? 217600
				: 136000;
		let calls = 0;
		ctx.set("llm", {
			resolveModelInfo: async () => ({ context: { contextWindow: 272000 } }),
		} as never);
		ctx.set("tokenMeter", {
			measure: () => ({
				totalTokens: tokens,
				nodes: [
					{ seq: 1, tokens: 200000 },
					{ seq: 2, tokens: 100000 },
				],
			}),
		} as never);
		class Engine extends Compaction {
			override async compactRegion() {
				calls++;
				tokens = 1;
				return {} as never;
			}
		}
		try {
			const engine = new Engine(
				ctx,
				Compaction.Config({
					auto: false,
					maxTokens: 8192,
					...config,
				}),
			);
			assert.equal(engine.config.modelPolicies[0]?.maxTokens, 8192);
			await engine.compactIfNeeded({ session: s } as never, "pressure");
			assert.equal(calls, 1);
		} finally {
			await ctx.fiber.dispose();
		}
	}
});

test("exhausted pressure retries throw, overflow still compacts below threshold, active lock refuses pressure", async () => {
	const ctx = new Context();
	await ctx.plugin(Registry).await();
	ctx.provide("llm");
	ctx.provide("tokenMeter");
	let calls = 0,
		tokens = 250000;
	const events = [
		event(0, "request/header", { header: header() }),
		user(1, "past"),
		user(2, "tail"),
	];
	let s = session(events);
	ctx.set("llm", {
		resolveModelInfo: async () => ({ context: { contextWindow: 272000 } }),
	} as never);
	ctx.set("tokenMeter", {
		measure: () => ({
			totalTokens: tokens,
			nodes: [
				{ seq: 1, tokens: 200000 },
				{ seq: 2, tokens: 100000 },
			],
		}),
	} as never);
	class Engine extends Compaction {
		override async compactRegion() {
			calls++;
			return {} as never;
		}
	}
	try {
		const engine = new Engine(
			ctx,
			Compaction.Config({ auto: false, compactionRetries: 1 }),
		);
		await assert.rejects(
			engine.compactIfNeeded({ session: s } as never, "pressure"),
			/still above/,
		);
		assert.equal(calls, 2);
		tokens = 100;
		await engine.compactIfNeeded({ session: s } as never, "context-overflow");
		assert.equal(calls, 3);
		s = session([...events, event(3, "compaction/start", {})]);
		await assert.rejects(
			engine.compactIfNeeded({ session: s } as never, "pressure"),
			/already in progress/,
		);
	} finally {
		await ctx.fiber.dispose();
	}
});

test("compaction projection tracks empty system heads, replacements and lock lifecycle", async () => {
	const ctx = new Context();
	await ctx.plugin(Registry).await();
	ctx.provide("llm");
	ctx.provide("tokenMeter");
	new Compaction(ctx, Compaction.Config({ auto: false }));
	const events = [
		event(
			0,
			"system/message",
			{
				message: { id: "system", role: "system", content: [] },
			},
			"append",
		),
		user(1, "tail"),
	];
	const s = session(events);
	const state = () =>
		ctx.sessionProjections.stateOf(s, "contextPolicyCompaction");
	const append = (next: SessionEvent) => {
		events.push(next);
		Object.assign(s, { seq: events.length });
	};
	try {
		assert.equal(state()?.systemHead, true);
		assert.equal(state()?.active, false);
		append(
			user(2, "replacement", {
				startSeq: SessionSeq(0),
				endSeq: SessionSeq(0),
			}),
		);
		assert.equal(state()?.headSeq, 2);
		assert.equal(state()?.systemHead, false);
		append(event(3, "compaction/start", {}));
		assert.equal(state()?.active, true);
		append(event(4, "session/end-seed", {}));
		assert.equal(state()?.active, false);
		append(event(5, "compaction/start", {}));
		assert.equal(state()?.active, true);
		append(event(6, "compaction/end", {}));
		assert.equal(state()?.active, false);
	} finally {
		await ctx.fiber.dispose();
	}
});

test("range selection preserves system head and does not split tool call/result pairs", () => {
	const events = [
		event(
			0,
			"system/message",
			{
				message: {
					id: "s",
					role: "system",
					content: [{ type: "text", text: "system" }],
				},
			},
			"append",
		),
		user(1, "past"),
		event(
			2,
			"assistant/message",
			{
				stream: [],
				message: {
					id: "a",
					role: "assistant",
					content: [
						{ type: "tool-call", id: "call", name: "tool", arguments: "{}" },
					],
				},
			},
			"append",
		),
		event(
			3,
			"tool/result",
			{
				message: {
					id: "t",
					role: "tool",
					content: [{ type: "text", text: "result" }],
				},
			},
			"append",
		),
		user(4, "tail"),
	];
	const s = session(events);
	const m = {
		nodes: events.map((e) => ({ seq: e.seq, tokens: 10, heuristicTokens: 2 })),
	} as ReturnType<typeof measureState>;
	assert.deepEqual(selectCompactableRange(s, m, 20, true), {
		start: 1,
		end: 1,
	});
	assert.equal(selectCompactableRange(s, m, 50, true), null);
});
