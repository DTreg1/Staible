#!/usr/bin/env python3
"""Fetch GGUF model specs from the Hugging Face API into a Staible catalog.

    ./scripts/fetch-hf-catalog.py unsloth/Qwen3.5-9B-GGUF ... > data/hf-catalog.json
    ./scripts/fetch-hf-catalog.py --top 20 > data/hf-catalog.json

The API gives parameter count, trained context, and per-file sizes. It does NOT
give layer or KV-head counts, so KV cache cost is estimated from parameter count
and anchored to a measured point (see KV_ANCHOR). Anything estimated is marked
as such so the UI can label it honestly.

Two traps this handles that a naive fetcher walks straight into:
  * split shards -- a 200 GB model is published as N files; sum them per quant
  * mmproj files -- vision projectors are not weights; exclude them
and then sanity-checks each quant's size against its parameter count, because a
match on the wrong file yields a confidently wrong number.
"""
import argparse, json, os, re, sys, urllib.request

API = "https://huggingface.co/api/models"
UA = {"User-Agent": "staible/1.0"}
# Anonymous reads are fine for normal use; a token only raises the rate limit.
if os.environ.get("HF_TOKEN"):
    UA["Authorization"] = "Bearer " + os.environ["HF_TOKEN"]

# Bits per weight for each quantisation, used only to sanity-check file sizes.
BPW = {"Q4_K_M": 4.85, "Q4_K_S": 4.6, "Q4_K": 4.85, "Q4_0": 4.55, "MXFP4": 4.25,
       "Q5_K_M": 5.7, "Q5_K_S": 5.5, "Q6_K": 6.6, "Q8_0": 8.5}
PREFER = ["Q4_K_M", "Q4_K_S", "Q4_K", "Q4_0", "MXFP4", "Q5_K_M", "Q6_K", "Q8_0"]
QUANT_RE = re.compile(r"(Q\d_K_[MS]|Q\d_K|Q\d_\d|MXFP4|BF16|F16)(?=[-._]|$)", re.I)

# Measured on an M3 with qwen3.5:9b: 8.95B parameters -> 40 MB of KV per 1k tokens.
# Everything else scales from here; replace with your own measurement if you have one.
KV_ANCHOR_PARAMS, KV_ANCHOR_MB, KV_EXP = 8.95, 40, 0.65


def get(url):
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30))


def est_kv(params_b):
    return round(KV_ANCHOR_MB * (params_b / KV_ANCHOR_PARAMS) ** KV_EXP)


def fetch(repo):
    d = get(f"{API}/{repo}?blobs=true")
    g = d.get("gguf") or {}
    params = (g.get("total") or 0) / 1e9
    if not params:
        raise ValueError("no GGUF parameter count (not a GGUF repo?)")

    sizes = {}
    for sib in d.get("siblings", []):
        fn, sz = sib.get("rfilename", ""), sib.get("size")
        if not fn.endswith(".gguf") or sz is None or "mmproj" in fn.lower():
            continue
        m = QUANT_RE.search(fn)
        if m:
            sizes[m.group(1).upper()] = sizes.get(m.group(1).upper(), 0) + sz / 1e9

    quants = {}
    for q, gb in sizes.items():
        if q not in BPW:
            continue
        expected = params * BPW[q] / 8
        if 0.75 <= gb / expected <= 1.35:          # reject wrong-file matches
            quants[q] = round(gb, 2)
    pick = next((q for q in PREFER if q in quants), None)
    if not pick:
        raise ValueError(f"no plausible quant file (saw {sorted(sizes)})")

    arch = g.get("architecture") or ""
    moe = "moe" in arch.lower() or bool(re.search(r"A\d+B", repo, re.I))
    name = repo.split("/")[-1]
    name = re.sub(r"-?GGUF$", "", name, flags=re.I)
    return {
        "id": re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-"),
        "name": name, "repo": repo, "quant": pick,
        "sizeGB": quants[pick], "weightsGB": quants[pick],
        "params": round(params, 2),
        "active": None if moe else round(params, 2),   # API cannot report active params
        "kvPer1kMB": est_kv(params), "kvMeasured": False,
        "maxCtx": g.get("context_length") or 131072,
        "arch": arch, "quants": dict(sorted(quants.items())),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("repos", nargs="*")
    ap.add_argument("--top", type=int, metavar="N",
                    help="instead of named repos, take the N most-downloaded GGUF repos")
    args = ap.parse_args()

    repos = args.repos
    if args.top:
        listing = get(f"{API}?filter=gguf&sort=downloads&direction=-1&limit={args.top}")
        repos = [m["id"] for m in listing]
    if not repos:
        ap.error("pass repo ids or --top N")

    out = []
    for r in repos:
        try:
            rec = fetch(r)
            out.append(rec)
            note = "  MoE: set active params by hand" if rec["active"] is None else ""
            print(f"{r:50s} {rec['params']:7.2f}B  {rec['quant']:7s} "
                  f"{rec['sizeGB']:6.2f}GB  ctx={rec['maxCtx']}{note}", file=sys.stderr)
        except Exception as e:
            print(f"skip {r}: {e}", file=sys.stderr)
    json.dump(out, sys.stdout, indent=1)
    print(f"\n{len(out)} models", file=sys.stderr)


if __name__ == "__main__":
    main()
