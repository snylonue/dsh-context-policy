# DSH Context Policy

Percentage-based automatic compaction and model-configurable token accounting for DeepSeek Harness (DSH). The package provides Cordis services, compiled ESM modules, and TypeScript declarations.

## Requirements

- Node.js 24 or later.
- DSH 0.2.0-rc.2. Compatibility is pinned to this release for its token-meter contracts, provider billing semantics, and public compaction service.
- The DSH peer dependencies declared in [package.json](./package.json).

## Installation

Install a release tarball into a DSH profile:


```sh
dsh plugin --profile example-profile add /absolute/path/to/snylonue-dsh-context-policy-0.1.0.tgz
```

Replace the profile name and archive path with the intended installation target. Use an absolute archive path: DSH forwards package-manager arguments to pnpm in the profile directory. The plugin manager registers newly installed bundles automatically.

The bundle applies [cordis.patch.yml](./cordis.patch.yml), which disables the upstream `token-meter` and `compaction-basic` entries, registers the replacement meter, and adds the percentage compaction service. Its defaults apply to all model routes; it contains no provider or model bindings. Keep one active implementation of each global `tokenMeter` and `compaction` service. The disable patches use the upstream entry IDs and module-name guards; configurations that rename those entries must disable their corresponding upstream services explicitly.

Inspect the composed configuration before starting the profile:


```sh
dsh --profile example-profile --dump-config
```

### Isolated presets

A preset that isolates the compaction service has its own implementation. Replace the compaction child in that preset's plugin list with `@snylonue/dsh-context-policy/compaction`, preserving the surrounding group and other plugins. [examples/preset-compaction.yml](./examples/preset-compaction.yml) supplies a plugin-list fragment.

DSH patches replace an entire config value. When updating a preset, preserve its complete configuration instead of applying a partial config that omits other settings.

Edit each affected preset's compaction plugin entry in place:

```yaml
# Before
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'

# After
- id: compaction-basic
  name: '@snylonue/dsh-context-policy/compaction'
```

Keep the existing entry ID, surrounding group, isolation settings, and configuration. If the entry has no explicit configuration, the package defaults apply. Configure thresholdRatio, retainRatio or retainTokens, and maxTokens on this child when a preset needs different values. Global percentage-compaction settings do not configure an isolated child.

These are plugin-list entries inside a preset, not top-level module-name match guards. The bundle handles disabling the standard global compaction entry; preset changes replace the existing child implementation.

## Default behavior

Automatic pressure compaction starts when projected input tokens reach the configured fraction of the model's context window. At the default `thresholdRatio` of 0.9, a hypothetical 100000-token window triggers at 90000 tokens. Output limits and the summary token budget do not reduce the threshold.

The pressure retention budget defaults to 16% of the full context window. A fixed `retainTokens` budget can replace the ratio. Range selection preserves the leading system message and complete tool call/result pairs. Compaction rechecks pressure after pruning and summarization, with a configurable retry limit.

The meter uses the `deepseek_v4` tokenizer by default. Provider defaults and model policies can select a different tokenizer. A successful request's provider-reported input usage calibrates subsequent custom measurements. Zero-usage failures preserve those measurements. Billing totals follow the upstream provider-usage accounting rules. The existing client pressure and composition views display the custom counts.

## Compaction configuration

The global entry has the ID percentage-compaction. The following is a profile patch for that entry:


```yaml
- id: percentage-compaction
  config:
    thresholdRatio: 0.9
    retainRatio: 0.16
    maxTokens: 8192
    compactionRetries: 1
    maxOverflowRetries: 1
    auto: true
```

For an isolated preset, place the configuration on its compaction child. Values below describe the automatic pressure policy unless otherwise stated.

| Option | Default | Description |
| --- | --- | --- |
| `thresholdRatio` | 0.9 | Trigger fraction of the full context window; greater than 0 and at most 1. |
| `retainRatio` | 0.16 | Retention fraction of the full window; nonnegative and below thresholdRatio. |
| `retainTokens` | Unset | Fixed nonnegative retention budget. Configure this instead of retainRatio. |
| `maxTokens` | 8192 | Positive output budget for the summarization request. |
| `compactionRetries` | 1 | Additional pressure compaction attempts if pressure remains above the threshold. |
| `maxOverflowRetries` | 1 | Retry limit used by the inherited context-overflow handler. |
| `auto` | true | Enables automatic compaction listeners. |
| `summarizationProvider` | Unset | Optional provider override for summarization. |
| `summarizationModel` | Unset | Optional model override for summarization. |
| `modelPolicies` | [] | Partial overrides for exact provider/model routes. Both identifiers are required. |
| `headroomTokens` | Ignored | Accepted for migration from the upstream configuration. |

A route override can adjust pressure behavior independently:


```yaml
modelPolicies:
  - provider: example-provider
    model: example-model
    thresholdRatio: 0.85
    retainTokens: 12000
    maxTokens: 4096
```

Use the provider identifier and model name registered in the target DSH installation. Fields omitted from a route override inherit the service configuration. The LLM adapter must supply `contextWindow` for pressure compaction.

## Token-meter configuration

The global entry has the ID model-token-meter. A profile patch can select a tokenizer and accounting policy per route:


```yaml
- id: model-token-meter
  config:
    defaultTokenizer: deepseek_v4
    providerTokenizers:
      example-provider: o200k_base
    modelPolicies:
      - provider: example-provider
        model: example-model
        tokenizer: o200k_base
        tokensPerMessage: 3
        toolsOverhead: 4
        replyPrimingTokens: 3
        includeReasoning: false
      - model: example-model
        tokenizer: o200k_base
```

The identifiers in this example are placeholders. An exact provider/model policy takes precedence over a model-only policy. The matched policy's explicit tokenizer overrides `providerTokenizers[provider]`, which overrides `defaultTokenizer`. A matched policy that omits tokenizer inherits the provider default or the global default. With no request header, the global default applies.

| Option | Default | Description |
| --- | --- | --- |
| `defaultTokenizer` | `deepseek_v4` | Registered tokenizer used when no model or provider tokenizer applies. |
| `providerTokenizers` | {} | Provider identifier to default tokenizer mapping, applied to all models on that provider. |
| `modelPolicies` | [] | Route-specific tokenizer and accounting settings. |
| `tokensPerMessage` | 3 | Per-message framing allowance. |
| `toolsOverhead` | 4 | Allowance added when tool definitions are present. |
| `replyPrimingTokens` | 3 | Request-level reply framing allowance. |
| `includeReasoning` | false | Includes visible reasoning text in the estimated message surface. |

The last four options belong to model policy entries. DSH validates these fields through the plugin configuration schema; token allowances must be nonnegative integers. For duplicate routes at the same specificity, the first matching entry is used. Unknown tokenizer names fail when text is counted.

### Builtin tokenizers

| Name | Vocabulary |
| --- | --- |
| `o200k_base` | Modern GPT vocabulary. |
| `deepseek_v4` | Official shared DeepSeek V4 Pro / Flash vocabulary and pre-tokenization rules; the default. |

DeepSeek V4 is the global default. Select GPT token counting for all models on a provider with a provider default:

```yaml
- id: model-token-meter
  config:
    defaultTokenizer: deepseek_v4
    providerTokenizers:
      openai: o200k_base
```

Use the provider identifiers configured in your DSH profile; `openai` is an example. Add `modelPolicies` when an individual model needs a different tokenizer or framing allowance.

Both builtins use `@huggingface/tokenizers` with compressed local assets loaded on first use, so counting works offline. The [GPT asset provenance](./assets/o200k-base/README.md) and [DeepSeek asset provenance](./assets/deepseek-v4/README.md) record the pinned sources, checksums, licenses, and reference fixture generation. The GPT asset preserves the previous `o200k_base` counting behavior, including its Unicode whitespace rules. Both builtins count literal special-token-looking content as ordinary text and add no BOS/EOS tokens. Complete requests remain estimates because provider chat framing and tool serialization are accounted for separately.

### Custom tokenizers

Register a synchronous counter before loading a meter that selects it:


```ts
import { registerTokenizer } from '@snylonue/dsh-context-policy/tokenizers';

export function registerModelTokenizer(encode: (text: string) => readonly number[]) {
  return registerTokenizer('custom-model', text => encode(text).length);
}
```

Call this function with the model's tokenizer implementation, then select `custom-model` in `defaultTokenizer` or a policy's tokenizer field. The returned function unregisters the counter; dispose dependent meters before calling it. Counters must return nonnegative safe integers. Text counts use a bounded cache, and special-token-looking input is treated as ordinary text by both builtin counters.

## Accounting and accuracy

The meter anchors a successful request's pre-response surface to DSH's normalized input usage, including cache reads and cache writes. It estimates the next request by adding the tokenized surface change, including visible assistant output and tool results. Header or route changes invalidate anchor reuse. Pruning, summary replacement, and attachment changes reprice the affected surface.

Text counts follow the selected tokenizer's vocabulary. Complete provider requests remain estimates because framing, tool serialization, image preprocessing, and provider templates can differ. Selecting `o200k_base` does not establish that an arbitrary model or provider uses o200k_base.

Image pricing uses the LLM adapter's batch pricing, and files use its `fileRequestText` projection. Missing adapter pricing falls back to structural counts and is exposed as `unpricedImages` or `unpricedFiles` in the measurement.

The meter is a plain Cordis `Service` registered as `tokenMeter`. It implements `measure()` and `estimateMessage()` and directly registers `tokenUsage`, `contextPressure`, and `contextBreakdown`. The default plugin entry validates configuration, and Cordis owns service and projection disposal. No inherited meter constructor, isolated registry, or definition wrapper is involved.

The host-only `contextPolicyMeter` projection stores the measurement state. The two UI projections share an explicit replay definition and each carries its own counting state because a wire view receives only its own state. They use the same counting functions as measurement. Their states preserve the native fields for fixed heuristic surface totals and composition, so existing host type contracts remain compatible; client views use custom pricing. Raw messages and calibration anchors stay on the host. Existing frontends keep reading the original keys.

| Projection or field | Meaning |
| --- | --- |
| `contextPressure.pressureTokens` | Reusable successful provider input sample, including cache reads and writes; absent when the calibration anchor no longer matches the request header. |
| `contextPressure.projectedTokens` | Custom next-request estimate, identical to the measurement used by percentage compaction. |
| `contextPressure.contextWindow` | Latest capacity from `request/context`; cleared when the event omits capacity. |
| `contextBreakdown` | Tokenizer-priced system, tool, and message composition. These estimates need not sum to the calibrated pressure total. |
| `tokenUsage` | Accumulated normalized input, output, and cache usage, including retries. |

UI states use distinct checkpoint versions to invalidate native-only and older wrapped caches. Their views are repriced with the current tokenizer configuration, so plugin reloads update both occupancy and composition even when restoring a compatible checkpoint. UI folds retain the previous state when counting inputs and capacity are unchanged, and views are cached by that state. The registry still advances its event watermark; the host-only meter state tracks the latest log revision. Measurement and billing share usage extraction: a defined direct sample takes precedence, otherwise they read the last usage chunk from the stream. The billing fold preserves upstream retry accumulation and replacement of repeated samples within the same attempt; its state shape and version remain compatible with native billing checkpoints.

Percentage compaction reads `ctx.tokenMeter.measure()` and uses its custom total and per-node `tokens` for triggering and retention. Durable `heuristicTokens` retain the upstream shadow-accounting protocol.

## Module exports

| Import path | API |
| --- | --- |
| `@snylonue/dsh-context-policy` | Default Cordis plugin (`Config`, `inject`, `apply`) and named ModelTokenMeter service class. |
| `@snylonue/dsh-context-policy/token-meter` | Same plugin entry and named ModelTokenMeter service class. |
| `@snylonue/dsh-context-policy/compaction` | PercentageCompactionEngine and its default service export. |
| `@snylonue/dsh-context-policy/tokenizers` | Tokenizer registration, text counting, and policy resolution. |
| `@snylonue/dsh-context-policy/core` | Custom counting replay, measurement, and provider-input helpers. |

## Compatibility

The compaction service extends `BasicCompactionEngine` and replaces automatic pressure range selection. Summarization, durable transactions, manual commands, and overflow listeners use the upstream implementation. Changes to the upstream `compactIfNeeded` dispatch require a compatibility review before updating the supported DSH version.

The meter uses the public Cordis service lifecycle and projection registration API. Its billing fold is maintained locally because the upstream definition is not exported at runtime. The public fixed-density estimator remains the source of durable shadow prices. Package upgrades should review billing event semantics, token-meter contracts, and checkpoint compatibility against the intended DSH release.

## Development and release

From a source checkout:


```sh
npm ci
npm run check
npm pack
```

The check command builds strict TypeScript, type-checks tests and tools, and runs the behavioral and loader tests. Source modules are in src; compiled ESM and declarations are emitted to dist. The prepack hook runs the same checks before creating a tarball.

To audit local session logs after building:


```sh
node scripts/audit.ts /absolute/path/to/session.v4.jsonl.zstd > audit.json
```

The audit reports prediction errors and zero-usage occupancy preservation without including message content. It uses the default tokenizer policy and runs without live adapter pricing, so attachment results have the same estimation limits described above.

## License

MIT. See [LICENSE](./LICENSE) and [UPSTREAM.md](./UPSTREAM.md) for upstream attribution and compatibility details.
