# DSH Context Policy

Percentage-based automatic compaction and model-configurable token accounting for DeepSeek Harness (DSH). The package provides Cordis services, compiled ESM modules, and TypeScript declarations.

## Requirements

- Node.js 24 or later.
- DSH 0.2.1-rc.2 or 0.2.1-rc.3; older hosts and untested later releases are not declared compatible.

Both host versions pass the build, TypeScript checks, and the full 39-test suite, including plugin composition, token accounting, projection replay/checkpoints, and percentage compaction. Development dependencies are pinned to 0.2.1-rc.3.

## Installation

Install the npm package into a DSH profile after the release is published:

```sh
dsh plugin --profile web add @snylonue/dsh-context-policy # or your profile
```

The bundle applies [cordis.patch.yml](./cordis.patch.yml), which replaces the global `token-meter` and `compaction-basic` entries supplied by DSH's base bundle. Its defaults apply to all model routes; it contains no provider or model bindings. DSH's presets also declare their own isolated compaction service; replace those children as described below.

Edit each affected preset's compaction plugin entry in place:

```yaml
# Before
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'

# After
- id: compaction-basic
  name: '@snylonue/dsh-context-policy/compaction'
```

Inspect the composed configuration before starting the profile:

```sh
dsh --profile web --dump-config # or your profile
```

## Default behavior

Automatic pressure compaction starts when projected input tokens reach the configured fraction of the model's context window. At the default `thresholdRatio` of 0.8, a hypothetical 100000-token window triggers at 80000 tokens. Output limits and the summary token budget do not reduce the threshold.

The numeric compaction defaults match DSH's default: `thresholdRatio: 0.8`, `retainRatio: 0.16`, and `maxTokens: 65536`. This plugin calculates pressure and retention against the full context window and ignores upstream headroom deductions. The pressure retention budget defaults to 16% of the full context window. A fixed `retainTokens` budget can replace the ratio. Range selection preserves the leading system message and complete tool call/result pairs. Compaction rechecks pressure after pruning and summarization, with a configurable retry limit.

The meter uses tokenizer for accurate esitimation. `deepseek_v4` tokenizer is used by default. Provider defaults and model policies can select a different tokenizer. A successful request's provider-reported input usage calibrates subsequent custom measurements. Zero-usage failures preserve those measurements. Billing totals follow the upstream provider-usage accounting rules. The existing client pressure and composition views display the custom counts.

## Compaction configuration

The global entry has the ID percentage-compaction. The following is a profile patch for that entry:

```yaml
- id: percentage-compaction
  config:
    thresholdRatio: 0.8
    retainRatio: 0.16
    # retainTokens: 12000 # Use instead of retainRatio; remove retainRatio first.
    maxTokens: 65536
    compactionRetries: 1
    maxOverflowRetries: 1
    auto: true
    # summarizationProvider: example-provider # Optional summarization route override.
    # summarizationModel: example-model
    providerPolicies: []
    modelPolicies: []
    headroomTokens: 0 # Accepted for migration; ignored by this plugin.
```

For an isolated preset, place the configuration on its compaction child. Values below describe the automatic pressure policy unless otherwise stated.

| Option | Default | Description |
| --- | --- | --- |
| `thresholdRatio` | 0.8 | Trigger fraction of the full context window; greater than 0 and at most 1. |
| `retainRatio` | 0.16 | Retention fraction of the full window; nonnegative and below thresholdRatio. |
| `retainTokens` | Unset | Fixed nonnegative retention budget. Configure this instead of retainRatio. |
| `maxTokens` | 65536 | Positive output budget for the summarization request. |
| `compactionRetries` | 1 | Additional pressure compaction attempts if pressure remains above the threshold. |
| `maxOverflowRetries` | 1 | Retry limit used by the inherited context-overflow handler. |
| `auto` | true | Enables automatic compaction listeners. |
| `summarizationProvider` | Unset | Optional provider override for summarization. |
| `summarizationModel` | Unset | Optional model override for summarization. |
| `providerPolicies` | [] | Default pressure policy for all models on a provider. |
| `modelPolicies` | [] | Partial overrides for exact provider/model routes. Both identifiers are required. |
| `headroomTokens` | Ignored | Accepted for migration from the upstream configuration. |

A route override can adjust pressure behavior independently:

```yaml
modelPolicies:
  - provider: example-provider
    model: example-model
    thresholdRatio: 0.85
    retainTokens: 12000
    # retainRatio: 0.16 # Use instead of retainTokens; remove retainTokens first.
    maxTokens: 4096
    compactionRetries: 1
    maxOverflowRetries: 1
    # summarizationProvider: example-summary-provider
    # summarizationModel: example-summary-model
    headroomTokens: 0 # Accepted for migration; ignored by this plugin.
```

Use the provider identifier and model name registered in the target DSH installation. Pressure policy fields inherit from service defaults → provider policy → exact model policy. Set `retainTokens` or `retainRatio` to replace the inherited retention form. Summary and overflow handlers continue to use upstream service/model configuration. `auto` is a service-wide option and cannot be overridden per route. The LLM adapter must supply `contextWindow` for pressure compaction.

## Token-meter configuration

The global entry has the ID model-token-meter. A profile patch can select a tokenizer and accounting policy per route:

```yaml
- id: model-token-meter
  config:
    defaultTokenizer: deepseek_v4
    providerPolicies:
      - provider: example-provider
        tokenizer: o200k_base
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

The identifiers in this example are placeholders. An exact provider/model policy takes precedence over a model-only policy. Each omitted policy field inherits from the provider policy, then from the global default. The matched model policy's explicit fields override the provider policy. With no request header, the global default applies.

| Option | Default | Description |
| --- | --- | --- |
| `defaultTokenizer` | `deepseek_v4` | Registered tokenizer used when no model or provider tokenizer applies. |
| `providerPolicies` | [] | Tokenizer and accounting defaults for all models on a provider. |
| `modelPolicies` | [] | Route-specific tokenizer and accounting settings. |
| `tokensPerMessage` | 3 | Per-message framing allowance. |
| `toolsOverhead` | 4 | Allowance added when tool definitions are present. |
| `replyPrimingTokens` | 3 | Request-level reply framing allowance. |
| `includeReasoning` | false | Includes visible reasoning text in the estimated message surface. |

The last four options belong to provider and model policy entries. Token allowances must be nonnegative integers. For duplicate routes at the same specificity, the first matching entry is used. Unknown tokenizer names fail when text is counted.

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
    providerPolicies:
      - provider: openai
        tokenizer: o200k_base
```

Use the provider identifiers configured in your DSH profile; `openai` is an example.

### Custom tokenizers

Register a synchronous counter before loading a meter that selects it:

```ts
import { registerTokenizer } from '@snylonue/dsh-context-policy/tokenizers';

export function registerModelTokenizer(encode: (text: string) => readonly number[]) {
  return registerTokenizer('custom-tokenizer', text => encode(text).length);
}
```

Call this function with the model's tokenizer implementation, then select `custom-tokenizer` in your profile. The returned function unregisters the counter; dispose dependent meters before calling it. Counters must return nonnegative safe integers. Text counts use a bounded cache, and special-token-looking input is treated as ordinary text by both builtin counters.

## Accounting and accuracy

Compared with DSH 0.2.0-rc.2's official `dsh-token-meter` and `dsh-compaction-basic`, this package changes the following behavior:

| Area | Official DSH | This plugin |
| --- | --- | --- |
| Text and tool counting | Fixed heuristic of roughly four characters per token, with fixed overheads. | Use a configurable tokenizer. |
| Calibration baseline | Uses reported input + cache + output when the request header matches and that total is at least the local estimate for the original request and response. | Uses positive reported input + cache from a successful request when the request header matches, even if it is below the local estimate. |
| Next-request estimate | Starts from the request and response baseline, then adjusts for subsequent content changes. | Starts from the input baseline, then counts retained reply text and later content changes with the configured tokenizer. Reported output usage, which may include hidden reasoning, is not added. |
| UI estimates | Context composition uses the fixed heuristic; displayed pressure is calculated separately from route-aware measurement. | Context composition uses the configured tokenizer and adapter attachment pricing. Displayed `projectedTokens` equals the measurement used by automatic compaction. |
| Measurement details | Returns pressure and surface counts with per-node prices. | Also reports the selected `tokenizer`, `toolsTokens`, and `unpricedImages` / `unpricedFiles` flags for attachments lacking adapter pricing. |
| Automatic compaction budgets | Trigger: `floor(min(W × thresholdRatio, W − O − B))`. Ratio retention: `floor((W − O) × retainRatio)`. | Trigger: `floor(W × thresholdRatio)`. Ratio retention: `floor(W × retainRatio)`. |
| Summary output budget | When `maxTokens` is omitted, it follows the resolved `headroomTokens`. | `maxTokens` defaults to 65536 independently of `headroomTokens`. |

`W` is the model's context window, `O` is the effective request output reservation, and `B` is the official compaction headroom.

## Module exports

| Import path | API |
| --- | --- |
| `@snylonue/dsh-context-policy` | Default Cordis plugin (`Config`, `inject`, `apply`) and named ModelTokenMeter service class. |
| `@snylonue/dsh-context-policy/token-meter` | Same plugin entry and named ModelTokenMeter service class. |
| `@snylonue/dsh-context-policy/compaction` | PercentageCompactionEngine and its default service export. |
| `@snylonue/dsh-context-policy/tokenizers` | Tokenizer registration, text counting, and policy resolution. |
| `@snylonue/dsh-context-policy/core` | Custom counting replay, measurement, and provider-input helpers. |

## Compatibility

The compaction service extends `BasicCompactionEngine` and replaces automatic pressure range selection. Summarization, durable transactions, manual commands, and overflow listeners use the upstream implementation.

The meter uses the public Cordis service lifecycle and projection registration API. Its billing fold is maintained locally because the upstream definition is not exported at runtime. Replay state does not retain fixed-density heuristic prices. Projection state, wire composition, and durable compaction shadow prices all use model-configured token counts. The current host still requires the upstream `heuristicTokens` field; it carries the same model count as `tokens`, not an older-host estimator. This does not change independent history estimators owned by other plugins.

## Development and release

From a source checkout:


```sh
pnpm install --frozen-lockfile
pnpm run check
npm pack
```

To audit local session logs after building:


```sh
node scripts/audit.ts /absolute/path/to/session.v4.jsonl.zstd > audit.json
```

The audit reports prediction errors and zero-usage occupancy preservation without including message content. It uses the default tokenizer policy and runs without live adapter pricing, so attachment results have the same estimation limits described above.

## License

MIT. See [LICENSE](./LICENSE).
