#!/usr/bin/env bash
# Derive a device's real constants by measuring Ollama, not by reading spec sheets.
#
#   ./scripts/measure-device.sh qwen3.5:9b
#   OLLAMA_HOST=http://desktop:11434 ./scripts/measure-device.sh qwen3-coder:30b
#
# Produces the three numbers Staible's model needs:
#   * effective memory bandwidth (GB/s)  -- from tok/s x resident weight bytes
#   * KV cache cost (MB per 1k tokens)   -- from the slope of resident size vs num_ctx
#   * prompt processing rate (tok/s)     -- drives time-to-first-token
#
# Every value here is an observation. Anything Staible cannot observe is labelled
# an estimate in the UI, and the two are never mixed.
set -uo pipefail

MODEL=${1:-}
[[ -z $MODEL ]] && { echo "usage: $0 <ollama-model>" >&2; exit 2; }
HOST=${OLLAMA_HOST:-http://localhost:11434}

command -v python3 >/dev/null || { echo "python3 required" >&2; exit 1; }

gen() {  # $1 num_ctx, $2 prompt, $3 num_predict -> raw JSON
  python3 -c "
import json,sys
print(json.dumps({'model':sys.argv[1],'prompt':sys.argv[3],'stream':False,
 'keep_alive':'120s','options':{'num_ctx':int(sys.argv[2]),
 'num_predict':int(sys.argv[4]),'temperature':0}}))" "$MODEL" "$1" "$2" "$3" \
  | curl -s "$HOST/api/generate" -d @-
}

resident() { curl -s "$HOST/api/ps" | python3 -c "
import sys,json
m=json.load(sys.stdin).get('models') or [{}]
print(m[0].get('size',0), m[0].get('size_vram',0))"; }

stop() { curl -s "$HOST/api/generate" -d "{\"model\":\"$MODEL\",\"keep_alive\":0}" >/dev/null 2>&1; }

echo "device measurement: $MODEL via $HOST"
echo

# ---- 1. resident size across context lengths -> KV slope -------------------
echo "context sweep"
printf '  %-10s %10s %10s %8s\n' num_ctx total_GB vram_GB on_gpu
SWEEP=""
for ctx in 4096 8192 16384 32768 65536 131072; do
  stop; sleep 1
  gen "$ctx" "hi" 1 >/dev/null
  read -r total vram <<<"$(resident)"
  [[ ${total:-0} -eq 0 ]] && { echo "  ctx=$ctx: model did not load (too large?)"; continue; }
  pct=$(python3 -c "print(f'{100*$vram/$total:.0f}%' if $total else 'n/a')")
  printf '  %-10s %10.2f %10.2f %8s\n' "$ctx" \
    "$(python3 -c "print($total/1e9)")" "$(python3 -c "print($vram/1e9)")" "$pct"
  SWEEP+="$ctx $total"$'\n'
done

# ---- 2. generation speed at a small context -> effective bandwidth ---------
stop; sleep 1
R=$(gen 4096 "Write a haiku about memory." 60)
read -r TOKS WEIGHTS <<<"$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
n=d.get('eval_count',0); t=d.get('eval_duration',1)/1e9
print(n/t if t else 0, 0)" <<<"$R")"
read -r total _ <<<"$(resident)"

# ---- 3. prompt processing rate --------------------------------------------
stop; sleep 1
LONG=$(python3 -c "print('The quick brown fox jumps over the lazy dog. '*900)")
P=$(gen 32768 "$LONG" 8)
read -r PPTOK <<<"$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
c=d.get('prompt_eval_count',0); t=d.get('prompt_eval_duration',1)/1e9
print(c/t if t else 0)" <<<"$P")"
stop

# ---- 4. derive the constants ----------------------------------------------
python3 - "$TOKS" "$total" "$PPTOK" "$SWEEP" <<'PY'
import sys
tok=float(sys.argv[1]); resident=float(sys.argv[2]); pp=float(sys.argv[3])
rows=[tuple(map(float,l.split())) for l in sys.argv[4].split("\n") if l.strip()]
print("\nderived constants")
kv=None
if len(rows)>=2:
    (c0,s0),(c1,s1)=rows[0],rows[-1]
    if c1>c0:
        kv=(s1-s0)/((c1-c0)/1024)/1e6              # MB per 1k tokens
        weights=(s0-kv*1e6*(c0/1024))/1e9          # back out the weight bytes
        print(f"  KV cache            {kv:8.1f} MB per 1k tokens")
        print(f"  model weights       {weights:8.2f} GB")
        if tok and weights>0:
            print(f"  effective bandwidth {tok*weights:8.1f} GB/s   (tok/s x weight GB)")
print(f"  generation          {tok:8.1f} tok/s")
print(f"  prompt processing   {pp:8.0f} tok/s")
print("\nPaste these into the device and model entries in Staible, and mark them measured.")
PY
