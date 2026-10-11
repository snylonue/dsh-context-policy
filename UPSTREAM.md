# Upstream attribution

Target: DeepSeek Harness 0.2.0-rc.2, MIT, copyright 2026 DeepSeek.

- LICENSE preserves the upstream MIT text because range selection and durable lock inspection in src/compaction.ts are adapted from dsh-compaction-basic, and the provider billing fold in src/usage.ts is adapted from dsh-token-meter.
- The compaction service subclasses the public BasicCompactionEngine instead of copying its summarizer or transaction engine. Automatic pressure selection uses full-window percentages and ignores legacy output/headroom deductions. Scoped listeners and overflow recovery remain inherited.
- The token-meter is a plain Cordis Service. It directly registers billing, pressure, and breakdown definitions through the public projection API. The provider billing fold retains upstream same-attempt sample replacement and retry accumulation, including cache buckets and stream-derived usage. Its checkpoint shape and version remain compatible with upstream billing. Sample extraction is shared with custom counting; bucket equality uses the public deepEqualJson utility.
- src/core.ts follows the official surface events for custom counting. The official estimateMessage export remains the fixed durable shadow heuristic; custom measurements retain their own provider-input calibration because no public upstream counting strategy hook is available.
- Custom counting uses the declared host-only contextPolicyMeter state. The two UI definitions share an explicit counting replay and preserve native fixed-heuristic state fields for type compatibility. Their distinct checkpoint version discards native-only and prior wrapped UI caches. UI folds preserve state identity when counting inputs and capacity are unchanged, allowing views to cache by state. Views apply the current tokenizer policy, including restored checkpoints. Existing clients keep reading contextPressure and contextBreakdown.
- js-tiktoken 1.0.21 supplies o200k_base. Its published license is retained in that dependency.

The package integrates through Cordis services and a DSH bundle patch. It does not require modifications to upstream runtime source files.
