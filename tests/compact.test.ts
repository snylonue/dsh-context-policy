import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import Registry from "@deepseek-ai/dsh-session-projection";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type {
	EpochHeader,
	Session,
	SessionEvent,
} from "@deepseek-ai/dsh-session";
import { SessionSeq, SessionLogOffset } from "@deepseek-ai/dsh-session";
import Meter from "../dist/token-meter.js";
import { fold, initialState, measureState } from "../dist/core.js";
import {
	compactSchema,
	foldCompact,
	initialCompactState,
	measureCompact,
} from "../dist/compact.js";
import {
	createDisplayProjections,
	createReplayProjection,
} from "../dist/projection.js";
import { registerTokenizer } from "../dist/tokenizers.js";

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
const header = (model = "m"): EpochHeader => ({
	config: { provider: "p", model, maxTokens: 1000 },
	tools: [],
});
const user = (seq: number, text: string, op: unknown = "append") =>
	event(
		seq,
		"user/message",
		createUserMessage({
			source: { kind: "user" },
			content: [{ type: "text", text }],
		}),
		op,
	);
const assistant = (seq: number, inputTokens = 100) =>
	event(
		seq,
		"assistant/message",
		{
			turn: 0,
			step: seq,
			stream: [],
			usage: {
				inputTokens,
				outputTokens: 10,
				cacheReadTokens: inputTokens > 0 ? 3 : 0,
				cacheWriteTokens: inputTokens > 0 ? 2 : 0,
			},
			message: {
				id: "a",
				role: "assistant",
				content: [
					{ type: "text", text: "reply" },
					{ type: "reasoning", text: "hidden reasoning" },
					{ type: "tool-call", name: "tool", id: "call", arguments: "{}" },
				],
			},
		},
		"append",
	);
function session(events: SessionEvent[]): Session {
	return {
		seq: events.length,
		header: {},
		inheritedEventCount: 0,
		snapshotEvents: () => events.slice(),
		eventAt: (seq: number) => events[seq],
	} as unknown as Session;
}
function stringCharacters(value: unknown): number {
	if (typeof value === "string") return value.length;
	if (!value || typeof value !== "object") return 0;
	return Object.values(value).reduce<number>(
		(sum, child) => sum + stringCharacters(child),
		0,
	);
}

test("all three live and persisted projections stay body-free with 720M logical legacy characters", async (t) => {
	const unregister = registerTokenizer("memory-test", (text) => text.length);
	const ctx = new Context();
	await ctx.plugin(Registry).await();
	const config = Meter.Config({ defaultTokenizer: "memory-test" });
	await ctx.plugin(Meter, config).await();
	try {
		const payload = `private-message-body:${"x".repeat(2_500_000 - 21)}`;
		const events = [
			event(0, "request/header", {
				header: {
					...header(),
					tools: [
						{
							name: "tool",
							description: `private-tool-description:${"y".repeat(100_000)}`,
							parameters: {},
						},
					],
				},
			}),
		];
		for (let i = 0; i < 48; i++) events.push(user(events.length, payload));
		events.push(assistant(events.length));
		const s = session(events);
		const legacy = events.reduce(fold, initialState());
		assert.deepEqual(ctx.tokenMeter.measure(s), measureState(legacy, config));
		const checkpoint = ctx.sessionProjections.checkpoint(s);
		const keys = [
			"contextPolicyMeter",
			"contextPressure",
			"contextBreakdown",
		] as const;
		let newCharacters = 0,
			serializedCharacters = 0;
		for (const key of keys) {
			const state = ctx.sessionProjections.stateOf(s, key);
			const encoded = JSON.stringify(state);
			assert(!encoded.includes("private-message-body"));
			assert(!encoded.includes("private-tool-description"));
			assert(!encoded.includes('"arguments":'));
			assert(!encoded.includes('"content":'));
			assert(!encoded.includes('"hidden reasoning"'));
			assert.deepEqual(
				JSON.parse(JSON.stringify(checkpoint[key]?.val)),
				JSON.parse(encoded),
			);
			newCharacters += stringCharacters(state);
			serializedCharacters += encoded.length;
		}
		assert(stringCharacters(legacy) * 3 >= 720_000_000);
		assert(newCharacters < 5000);
		assert(serializedCharacters < 100_000);
		const roundtrip = JSON.parse(JSON.stringify(checkpoint));
		assert.deepEqual(
			ctx.sessionProjections.viewCheckpoint(roundtrip),
			ctx.sessionProjections.snapshot(s).values,
		);
		// A checkpoint must suffice: no transient text side table or full log needed.
		const restored = ctx.sessionProjections.restore(
			roundtrip,
			[],
			SessionLogOffset(events.length),
			s.header,
			SessionLogOffset(0),
		);
		assert.deepEqual(
			restored.snapshot.values,
			ctx.sessionProjections.snapshot(s).values,
		);
		t.diagnostic(
			JSON.stringify({
				legacyLogicalCharacters: stringCharacters(legacy) * 3,
				retainedStringCharacters: newCharacters,
				serializedCharacters,
			}),
		);
	} finally {
		await ctx.fiber.dispose();
		unregister();
	}
});

test("compact counts match full replay through route changes, usage, offload and replacements", () => {
	const unregister = registerTokenizer(
		"compact-characters",
		(text) => text.length,
	);
	const config = Meter.Config({
		defaultTokenizer: "o200k_base",
		providerPolicies: [{ provider: "q", tokenizer: "deepseek_v4" }],
		modelPolicies: [
			{
				model: "other",
				tokenizer: "compact-characters",
				includeReasoning: true,
				tokensPerMessage: 31,
				toolsOverhead: 17,
				replyPrimingTokens: 5,
			},
		],
	});
	const services = {
		llm: {
			imageRequestPricing: (_provider: string, model: string) => ({
				priceImages: (images: readonly { offloaded?: boolean }[]) =>
					images.map((image, i) => ({
						visualTokens: image.offloaded
							? 0
							: (model === "other" ? 100 : 200) + i,
						text: "image placeholder",
					})),
			}),
			fileRequestText: () => "rendered file handle",
		},
	};
	try {
		const events = [
			event(
				0,
				"system/message",
				{ message: { role: "system", content: [] } },
				"append",
			),
			user(1, "你好世界"),
			event(2, "request/header", { header: header() }),
			event(
				3,
				"user/message",
				createUserMessage({
					source: { kind: "user" },
					content: [
						{ type: "image", attachment: { id: "image" } } as never,
						{ type: "image", attachment: { id: "image2" } } as never,
						{ type: "file", attachment: { id: "file" } } as never,
					],
				}),
				"append",
			),
			assistant(4),
			event(5, "image/offload", {
				targets: [{ seq: SessionSeq(3), imageIndexes: [0] }],
			}),
			assistant(6, 0),
			event(7, "assistant/attempt", {
				stream: [
					{ type: "usage", usage: { inputTokens: 500, outputTokens: 3 } },
				],
				turn: 0,
				step: 7,
			}),
			event(8, "llm/retry-started", { turn: 0, step: 7 }),
			event(9, "request/header", {
				header: {
					...header("other"),
					tools: [
						{
							name: "tool",
							description: "schema",
							parameters: { type: "object" },
						},
					],
				},
			}),
			assistant(10),
			user(11, "summary", { startSeq: SessionSeq(1), endSeq: SessionSeq(3) }),
			event(12, "request/header", {
				header: { ...header(), config: { ...header().config, provider: "q" } },
			}),
			event(13, "request/header", { header: header() }),
		];
		for (const pricing of [services, {}]) {
			let full = initialState(),
				compact = initialCompactState();
			const display = createDisplayProjections(config, pricing);
			let pressure = display.pressure.init(),
				breakdown = display.breakdown.init();
			for (const next of events) {
				full = fold(full, next);
				compact = foldCompact(compact, next, config);
				pressure = display.pressure.apply(pressure, next);
				breakdown = display.breakdown.apply(breakdown, next);
				const expected = measureState(full, config, pricing);
				assert.deepEqual(measureCompact(compact, config, pricing), expected);
				assert.equal(
					display.pressure.wire.view(pressure).projectedTokens,
					expected.totalTokens,
				);
				assert.equal(breakdown.surfaceTokens, expected.surfaceTokens);
				compact = compactSchema.parse(JSON.parse(JSON.stringify(compact)));
				pressure = display.pressure.stateSchema.parse(
					JSON.parse(JSON.stringify(pressure)),
				);
				breakdown = display.breakdown.stateSchema.parse(
					JSON.parse(JSON.stringify(breakdown)),
				);
				for (const request of [header(), header("other")])
					assert.deepEqual(
						measureCompact(compact, config, pricing, request),
						measureState(full, config, pricing, request),
					);
			}
		}
	} finally {
		unregister();
	}
});

test("body-bearing cache versions are rejected and rebuilt without their payloads", async () => {
	const ctx = new Context();
	await ctx.plugin(Registry).await();
	await ctx
		.plugin(Meter, Meter.Config({ defaultTokenizer: "o200k_base" }))
		.await();
	try {
		const events = [
			event(0, "request/header", { header: header() }),
			user(1, "legacy-secret-payload"),
			assistant(2),
		];
		const s = session(events);
		const old = ctx.sessionProjections.checkpoint(s);
		const legacy = events.reduce(fold, initialState());
		for (const key of [
			"contextPressure",
			"contextBreakdown",
			"contextPolicyMeter",
		] as const) {
			const row = old[key];
			assert(row);
			row.ver = key === "contextPolicyMeter" ? 2 : 9;
			row.val = legacy;
		}
		assert.equal(ctx.sessionProjections.restoreFloor(old), 0);
		assert.equal(
			ctx.sessionProjections.viewCheckpoint(old).contextPressure,
			undefined,
		);
		const restored = ctx.sessionProjections.restore(
			old,
			events,
			SessionLogOffset(0),
			s.header,
			SessionLogOffset(0),
		);
		assert.deepEqual(
			restored.snapshot.values,
			ctx.sessionProjections.snapshot(s).values,
		);
		assert(
			!JSON.stringify(restored.checkpoint).includes("legacy-secret-payload"),
		);
	} finally {
		await ctx.fiber.dispose();
	}
});

test("counting and restoring text-only summaries never retokenizes retained bodies", () => {
	let calls = 0;
	const unregister = registerTokenizer("count-once", (text) => {
		calls++;
		return text.length;
	});
	try {
		const config = Meter.Config({ defaultTokenizer: "count-once" });
		let state = initialCompactState();
		state = foldCompact(
			state,
			event(0, "request/header", { header: header() }),
			config,
		);
		state = foldCompact(state, user(1, "x".repeat(2_000_001)), config);
		assert.equal(calls, 1);
		for (let i = 0; i < 10; i++) {
			state = compactSchema.parse(JSON.parse(JSON.stringify(state)));
			assert.equal(measureCompact(state, config).surfaceTokens, 2_000_004);
			measureCompact(state, config, {}, header("other"));
		}
		assert.equal(calls, 1);
	} finally {
		unregister();
	}
});

test("compact calibration summaries survive adapter availability and pricing changes", () => {
	const config = Meter.Config({ defaultTokenizer: "o200k_base" });
	const available = {
		llm: {
			imageRequestPricing: () => ({
				priceImages: (images: readonly { offloaded?: boolean }[]) =>
					images.map((image, i) => ({
						visualTokens: image.offloaded ? 0 : 100 + i,
						text: "image handle",
					})),
			}),
			fileRequestText: () => "saved file handle",
		},
	};
	const events = [
		event(0, "request/header", { header: header() }),
		event(
			1,
			"user/message",
			createUserMessage({
				source: { kind: "user" },
				content: [
					{ type: "image", attachment: { id: "i" } } as never,
					{ type: "file", attachment: { id: "f" } } as never,
				],
			}),
			"append",
		),
		user(2, "text-only body must not enter the anchor"),
		assistant(3),
		event(4, "image/offload", {
			targets: [{ seq: SessionSeq(1), imageIndexes: [0] }],
		}),
	];
	const full = events.reduce(fold, initialState());
	let state = events.reduce(
		(s, e) => foldCompact(s, e, config),
		initialCompactState(),
	);
	state = compactSchema.parse(JSON.parse(JSON.stringify(state)));
	assert.equal(state.anchor?.nodes.filter((node) => node.message).length, 1);
	assert.deepEqual(
		state.anchor?.nodes.filter((node) => node.message).map((node) => node.seq),
		[1],
	);
	for (const services of [
		available,
		{},
		{
			llm: {
				...available.llm,
				fileRequestText: () => "changed file path and name",
			},
		},
	]) {
		assert.deepEqual(
			measureCompact(state, config, services),
			measureState(full, config, services),
		);
	}
});

test("display checkpoints remove an unknown context window without retaining an old value", () => {
	const display = createDisplayProjections(Meter.Config({}), {});
	let state = display.pressure.init();
	state = display.pressure.apply(
		state,
		event(0, "request/context", { contextWindow: 128000 }),
	);
	assert.equal(display.pressure.wire.view(state).contextWindow, 128000);
	state = display.pressure.apply(state, event(1, "request/context", {}));
	assert.equal("contextWindow" in state, false);
	assert.equal("contextWindow" in display.pressure.wire.view(state), false);
	assert.deepEqual(
		display.pressure.stateSchema.parse(JSON.parse(JSON.stringify(state))),
		state,
	);
});

test("checkpoint versions change with every counting policy", () => {
	const config = Meter.Config({});
	const base = createReplayProjection(config);
	assert.equal(
		base.stateVersion,
		createReplayProjection(structuredClone(config)).stateVersion,
	);
	for (const input of [
		{ defaultTokenizer: "o200k_base" },
		{ providerPolicies: [{ provider: "p", tokensPerMessage: 7 }] },
		{ modelPolicies: [{ model: "m", includeReasoning: true }] },
	]) {
		const changed = createReplayProjection(Meter.Config(input));
		assert.notEqual(changed.stateVersion, base.stateVersion);
	}
});
