import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import { SessionSeq } from "@deepseek-ai/dsh-session";
import Registry from "@deepseek-ai/dsh-session-projection";
import { Tokenizer } from "@huggingface/tokenizers";
import { createTokenizerCounter } from "../dist/builtin-tokenizers.js";
import { foldCompact, initialCompactState } from "../dist/compact.js";
import Meter from "../dist/token-meter.js";
import { registerTokenizer } from "../dist/tokenizers.js";

function user(seq: number, text: string): SessionEvent {
	return {
		type: "user/message",
		seq: SessionSeq(seq),
		time: seq,
		data: createUserMessage({
			source: { kind: "user" },
			content: [{ type: "text", text }],
		}),
		surfaceOp: "append",
	} as SessionEvent;
}
function session(events: SessionEvent[]): Session {
	return {
		seq: events.length,
		header: {},
		inheritedEventCount: 0,
		snapshotEvents: () => events.slice(),
		eventAt: (seq: number) => events[seq],
	} as unknown as Session;
}

test("cold registry replay counts each event once across three projections beyond both text-cache limits", async () => {
	let callsA = 0;
	let callsB = 0;
	const unregisterA = registerTokenizer("replay-a", (text) => {
		callsA++;
		return text.length;
	});
	const unregisterB = registerTokenizer("replay-b", (text) => {
		callsB++;
		return text.length + 11;
	});
	const ctx = new Context();
	try {
		await ctx.plugin(Registry).await();
		await ctx
			.plugin(
				Meter,
				Meter.Config({
					defaultTokenizer: "replay-a",
					providerPolicies: [{ provider: "p", tokenizer: "replay-b" }],
				}),
			)
			.await();
		const tools = [{ name: "tool", parameters: {} }];
		const events: SessionEvent[] = [
			{
				type: "request/header",
				seq: SessionSeq(0),
				time: 0,
				data: { header: { config: { provider: "p", model: "m" }, tools } },
			} as SessionEvent,
		];
		for (let i = 0; i < 600; i++) {
			events.push(
				user(
					events.length,
					`${String(i).padStart(4, "0")}:${"x".repeat(4495)}`,
				),
			);
		}
		const s = session(events);
		const values = ctx.sessionProjections.snapshot(s).values;
		const measurement = ctx.tokenMeter.measure(s);
		assert.equal(callsA, 601);
		assert.equal(callsB, 601);
		assert.equal(measurement.surfaceTokens, 600 * (4500 + 11 + 3));
		const toolsTokens = JSON.stringify(tools).length + 11 + 4;
		assert.equal(
			measurement.totalTokens,
			measurement.surfaceTokens + toolsTokens + 3,
		);
		assert.equal(
			values.contextPressure?.projectedTokens,
			measurement.totalTokens,
		);
		assert.deepEqual(values.contextBreakdown, {
			systemTokens: 0,
			toolsTokens,
			messageTokens: measurement.surfaceTokens,
		});
		const checkpoint = JSON.parse(
			JSON.stringify(ctx.sessionProjections.checkpoint(s)),
		);
		assert.deepEqual(ctx.sessionProjections.viewCheckpoint(checkpoint), values);
		assert.equal(
			callsA,
			601,
			"checkpoint/view reads must not recount evicted bodies",
		);
		assert.equal(callsB, 601);
	} finally {
		await ctx.fiber.dispose();
		unregisterA();
		unregisterB();
	}
});

test("oversized uncached text is counted once, not once per projection", async () => {
	let calls = 0;
	const unregister = registerTokenizer("replay-large", (text) => {
		calls++;
		return text.length;
	});
	const ctx = new Context();
	try {
		await ctx.plugin(Registry).await();
		await ctx
			.plugin(Meter, Meter.Config({ defaultTokenizer: "replay-large" }))
			.await();
		const s = session([user(0, "x".repeat(2_000_001))]);
		ctx.sessionProjections.snapshot(s);
		assert.equal(ctx.tokenMeter.measure(s).surfaceTokens, 2_000_004);
		assert.equal(calls, 1);
	} finally {
		await ctx.fiber.dispose();
		unregister();
	}
});

test("payload memo separates event identity and tokenizer sets, not sequence numbers", () => {
	const unregisterA = registerTokenizer(
		"replay-identity-a",
		(text) => text.length,
	);
	const unregisterB = registerTokenizer(
		"replay-identity-b",
		(text) => text.length * 2,
	);
	try {
		const a = Meter.Config({ defaultTokenizer: "replay-identity-a" });
		const b = Meter.Config({ defaultTokenizer: "replay-identity-b" });
		const first = user(0, "first");
		const otherSession = user(0, "different session");
		const fold = (event: SessionEvent, config = a) =>
			foldCompact(initialCompactState(), event, config);
		const firstCounts = fold(first).nodes[0].counts;
		assert.equal(firstCounts.text["replay-identity-a"], 5);
		assert.strictEqual(fold(first).nodes[0].counts, firstCounts);
		assert(Object.isFrozen(firstCounts));
		assert(Object.isFrozen(firstCounts.text));
		assert.throws(() => {
			firstCounts.text["replay-identity-a"] = 99;
		}, TypeError);
		assert.equal(
			fold(otherSession).nodes[0].counts.text["replay-identity-a"],
			17,
		);
		assert.equal(fold(first, b).nodes[0].counts.text["replay-identity-b"], 10);
		assert.equal(fold(first).nodes[0].counts.text["replay-identity-a"], 5);
	} finally {
		unregisterA();
		unregisterB();
	}
});

test("re-registering a custom tokenizer cannot reuse old event counts", () => {
	const config = Meter.Config({ defaultTokenizer: "replay-replaced" });
	const event = user(0, "payload");
	const unregister = registerTokenizer(
		"replay-replaced",
		(text) => text.length,
	);
	try {
		assert.equal(
			foldCompact(initialCompactState(), event, config).nodes[0].counts.text[
				"replay-replaced"
			],
			7,
		);
	} finally {
		unregister();
	}
	assert.throws(
		() => foldCompact(initialCompactState(), event, config),
		/Unknown tokenizer/,
	);
	const unregisterAgain = registerTokenizer(
		"replay-replaced",
		(text) => text.length * 2,
	);
	try {
		assert.equal(
			foldCompact(initialCompactState(), event, config).nodes[0].counts.text[
				"replay-replaced"
			],
			14,
		);
	} finally {
		unregisterAgain();
	}
});

test("numeric payload memos do not keep discarded event objects alive", () => {
	const compact = JSON.stringify(
		new URL("../dist/compact.js", import.meta.url).href,
	);
	const tokenizers = JSON.stringify(
		new URL("../dist/tokenizers.js", import.meta.url).href,
	);
	const script = [
		`import {foldCompact, initialCompactState} from ${compact};`,
		`import {registerTokenizer} from ${tokenizers};`,
		"registerTokenizer('gc-counter', text => text.length);",
		"let ref;",
		"(() => {",
		" const event = {type:'user/message', seq:0, time:0, surfaceOp:'append', data:{role:'user', id:'gc', source:{kind:'user'}, content:[{type:'text', text:'discarded body'}]}};",
		" foldCompact(initialCompactState(), event, {defaultTokenizer:'gc-counter', modelPolicies:[]});",
		" ref = new WeakRef(event);",
		"})();",
		"for (let i=0; i<16; i++) {",
		" await new Promise(resolve => setImmediate(resolve));",
		" globalThis.gc();",
		" if (!ref.deref()) process.exit(0);",
		"}",
		"throw new Error('payload memo retained the event');",
	].join("\n");
	// GC runs only in this disposable child, never the host or main test process.
	const result = spawnSync(
		process.execPath,
		["--expose-gc", "--input-type=module", "-e", script],
		{
			encoding: "utf8",
			timeout: 10_000,
		},
	);
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("builtin token counts do not allocate token IDs or attention masks", (t) => {
	t.mock.method(Tokenizer.prototype, "encode", () => {
		throw new Error("counting must use tokenize rather than encode");
	});
	for (const name of ["deepseek-v4", "o200k-base"]) {
		const count = createTokenizerCounter(name);
		assert.equal(count(""), 0);
		assert(count("hello 世界 <|endoftext|>") > 0);
	}
});
