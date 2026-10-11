# o200k_base tokenizer asset

Both builtin counters use `@huggingface/tokenizers`. This GPT asset is based on [Xenova/gpt-4o](https://huggingface.co/Xenova/gpt-4o/blob/7956d98f2a83b2751a98ea7136fdf7fe6cf54e69/tokenizer.json), pinned to revision `7956d98f2a83b2751a98ea7136fdf7fe6cf54e69`.

- Source JSON SHA-256: `43a3ad4618a6a938f8c2614154ea10c31ad53a62d5683ae0b0e6133575cef07e`.
- Bundled decompressed JSON SHA-256: `d807dc8b57ba3e3dbddb94324dcb4e359e20d83a8c8d68a73d2e8b01e70a1ace`.
- All 199998 mergeable vocabulary entries and IDs were checked against [OpenAI's official o200k_base ranks](https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken), SHA-256 `446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d`.
- The source model card specifies MIT licensing; the upstream OpenAI tiktoken license is preserved in [LICENSE](./LICENSE).

[prepare-o200k.ts](../../scripts/prepare-o200k.ts) validates the pinned source checksum, removes added tokens, enables whole-piece vocabulary lookup (`ignore_merges`), and expands whitespace shorthands into explicit ECMAScript character classes. This preserves the previous `js-tiktoken` counter's treatment of U+FEFF and U+0085 while using Hugging Face's BPE engine. No BOS/EOS tokens are added.

Reproduce the gzip asset from the repository root:

```sh
mkdir -p .cache
curl -fL https://huggingface.co/Xenova/gpt-4o/resolve/7956d98f2a83b2751a98ea7136fdf7fe6cf54e69/tokenizer.json -o .cache/o200k-tokenizer.json
node scripts/prepare-o200k.ts .cache/o200k-tokenizer.json
```

The golden counts in [o200k-base-fixtures.json](../../tests/o200k-base-fixtures.json) were captured from `js-tiktoken` 1.0.21 using `new Tiktoken(ranks).encode(text, [], []).length` before removing that dependency. They include multilingual text, code, literal control markers, Unicode whitespace, and lone UTF-16 surrogates. Tests use these stored reference counts and require only the current tokenizer dependency.
