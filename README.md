# Staible

A stable of machines, and which local LLMs actually run in it.

Staible answers one question: *given this model and this machine, will it run, and
will it be usable?* It is built for a heterogeneous home fleet — Apple Silicon
laptops, a discrete-GPU box, a couple of SBCs — where the generic "VRAM calculator"
answer is wrong for most of the hardware.

The published tool is a single self-contained page: a fitment matrix of devices ×
models, a context-length slider that recomputes every cell, and a per-pair inspector
with memory and speed curves.

## Why not just use a VRAM calculator

Every calculator worth using takes hardware specs as *input*, and nearly all of them
assume one discrete GPU with separate VRAM and system RAM. That assumption produces
two specific errors on a mixed fleet:

**Spilling is not one behaviour.** When layers don't fit in fast memory, they land on
the CPU. On a discrete GPU that means crossing PCIe, and the penalty is a cliff. On
Apple Silicon the "CPU" layers read the *same physical RAM*, and the penalty is mild.
Measured here: forcing a 45% CPU / 55% GPU split on an M3 cost about 10%
(15.4 → 13.9 tok/s). The same split on a 4090 is catastrophic. Staible models the two
as separate memory pools blended harmonically, so both fall out of one formula.

**Download size is the floor, not the total.** The GGUF file is the weights, all of
which must be resident. On top sit the KV cache — linear in context length, allocated
up front — and runtime overhead. A 17 GB model on a 16 GB machine was never going to
run, but neither is a 13 GB one at 128k context.

## The model

Generation is memory-bandwidth bound: producing a token requires reading every
*active* weight. So

```
tok/s  ≈  effective bandwidth  ÷  active weight bytes
```

with three qualifiers that matter in practice:

- **Effective bandwidth** blends the fast and slow pools by the fraction of layers in
  each: `1 / (fastFrac/bwFast + cpuFrac/bwSlow)`. Unified memory's slow pool is fast;
  a discrete GPU's is not. This single term produces both the gentle slope and the cliff.
- **Active** weights, not total. A 30B MoE with 3.3B active occupies memory like a 30B
  and generates like a small dense model. Size predicts speed only for dense models.
- **Quantisation is a separate axis.** A 10 GB Q8 of a 9B and a 10 GB Q4 of a 27B are
  the same bytes and roughly the same speed, and not remotely the same quality. Size
  predicts speed; it never predicts capability.

Context costs memory linearly and latency worse than that. Measured on an M3: KV cache
grew ~40 MB per 1k tokens, so 262k context cost 10.5 GB on top of a 5.4 GB model. But
*declaring* a large context is cheap and *filling* it is not — feeding 9,018 real tokens
took 60 s of prompt processing before the first output token, while generation barely
moved. The practical default is 16–32k; 1M on a model card is what it was trained to
handle, not a setting to use.

## Measured vs estimated

Every number in the UI is tagged. The distinction is load-bearing, so it is never blurred.

| Constant | Value | Source |
|---|---|---|
| ultron effective bandwidth | 83 GB/s | measured — 5.4 GB weights at 15.4 tok/s |
| qwen3.5:9b KV cache | 40 MB / 1k tokens | measured — resident size across a num_ctx sweep |
| ultron prompt processing | 149 tok/s | measured — 9,018-token prompt |
| every other bandwidth | vendor figure, derated ~20% | estimated |
| every other KV cost | `40 × (params/8.95)^0.65` | estimated, anchored to the measured point |

Re-derive any of them with `scripts/measure-device.sh`.

## Layout

```
web/index.html              the tool — self-contained, no build step
scripts/probe-fleet.sh      SSH hardware inventory -> data/fleet.json
scripts/measure-device.sh   Ollama measurement harness -> bandwidth, KV, prompt rate
scripts/fetch-hf-catalog.py Hugging Face GGUF specs -> data/hf-catalog.json
data/                       measured fleet inventory and fetched model catalog
```

## Use

```bash
# 1. inventory the fleet (unreachable hosts are recorded as unknown, not guessed)
./scripts/probe-fleet.sh ultron vision optimus r2d2 jetson > data/fleet.json

# 2. measure a machine that has Ollama, to replace estimates with observations
./scripts/measure-device.sh qwen3.5:9b
OLLAMA_HOST=http://optimus:11434 ./scripts/measure-device.sh qwen3-coder:30b

# 3. refresh model specs from Hugging Face
./scripts/fetch-hf-catalog.py --top 20 > data/hf-catalog.json

# 4. open the tool
open web/index.html
```

Devices and models are editable in the page and persist to `localStorage`.
"Reset to my fleet" restores the measured baseline compiled into the page.

### Importing a model from Hugging Face

The page is published as a sandboxed artifact and cannot call external hosts, so the
importer is a deliberate round trip: enter a repo id, press **Open** to load the API
response in a new tab, paste it back, press **Read specs**. It sums split shards,
excludes `mmproj` vision projectors, sanity-checks each quant's size against the
parameter count, and flags MoE repos so you set active parameters yourself — the API
does not report them.

`scripts/fetch-hf-catalog.py` does the same thing without the round trip when you are
working locally.

## Known gaps

- `sentinel` and `deadpool` did not answer SSH during inventory; they carry no specs.
- Only qwen3.5:9b has a measured KV cost. Every other model's is estimated.
- Prompt-processing rates for machines other than ultron are estimates.
- MoE active-parameter counts come from the model card, not from any API.
