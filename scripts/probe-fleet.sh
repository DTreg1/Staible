#!/usr/bin/env bash
# Probe each host over SSH and emit a fleet inventory as JSON.
#
#   ./scripts/probe-fleet.sh ultron vision optimus r2d2 jetson > data/fleet.json
#
# Hosts are SSH aliases. The local machine is detected by hostname and probed
# without SSH. Unreachable hosts are emitted with kind "unknown" rather than
# guessed at — an absent number is always better than an invented one.
set -uo pipefail

HOSTS=("$@")
[[ ${#HOSTS[@]} -eq 0 ]] && { echo "usage: $0 <host> [host...]" >&2; exit 2; }

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=6 -o StrictHostKeyChecking=accept-new)

# Emitted on the remote host; prints KEY=VALUE lines.
read -r -d '' REMOTE_PROBE <<'PROBE'
case "$(uname -s)" in
  Darwin)
    echo "OS=darwin"
    echo "MODEL=$(sysctl -n hw.model 2>/dev/null)"
    echo "CHIP=$(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
    echo "RAM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))"
    echo "WIRED_MB=$(sysctl -n iogpu.wired_limit_mb 2>/dev/null || echo 0)"
    echo "CORES=$(sysctl -n hw.ncpu)"
    ;;
  Linux)
    echo "OS=linux"
    echo "CHIP=$(awk -F': ' '/^model name/{print $2; exit}' /proc/cpuinfo)"
    echo "RAM_GB=$(awk '/MemTotal/{printf "%d", $2/1048576 + 0.5}' /proc/meminfo)"
    echo "CORES=$(nproc 2>/dev/null || echo 0)"
    if command -v nvidia-smi >/dev/null 2>&1; then
      echo "GPU=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)"
      echo "VRAM_GB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1 | awk '{printf "%d", $1/1024 + 0.5}')"
    fi
    [[ -f /etc/nv_tegra_release ]] && echo "TEGRA=$(head -1 /etc/nv_tegra_release)"
    ;;
  *) echo "OS=unknown" ;;
esac
command -v ollama >/dev/null 2>&1 && echo "OLLAMA=$(ollama list 2>/dev/null | tail -n +2 | awk '{print $1}' | paste -sd, -)"
PROBE

emit_host() {              # $1 host, $2 probe output ("" when unreachable)
  local host=$1 out=$2
  if [[ -z $out ]]; then
    printf '  {"id":"%s","name":"%s","kind":"unknown","reachable":false}' "$host" "$host"
    return
  fi
  local os model chip ram wired cores gpu vram tegra ollama kind vram_out
  os=$(sed -n 's/^OS=//p'      <<<"$out"); model=$(sed -n 's/^MODEL=//p'  <<<"$out")
  chip=$(sed -n 's/^CHIP=//p'  <<<"$out"); ram=$(sed -n 's/^RAM_GB=//p'   <<<"$out")
  wired=$(sed -n 's/^WIRED_MB=//p' <<<"$out"); cores=$(sed -n 's/^CORES=//p' <<<"$out")
  gpu=$(sed -n 's/^GPU=//p'    <<<"$out"); vram=$(sed -n 's/^VRAM_GB=//p'  <<<"$out")
  tegra=$(sed -n 's/^TEGRA=//p' <<<"$out"); ollama=$(sed -n 's/^OLLAMA=//p' <<<"$out")

  # Architecture decides how a spill is penalised, so classify it explicitly.
  if   [[ $os == darwin ]];            then kind=unified
  elif [[ -n ${vram:-} ]];             then kind=discrete
  elif [[ $os == linux ]];             then kind=cpu
  else                                      kind=unknown
  fi

  vram_out=${vram:-0}
  printf '  {"id":"%s","name":"%s","kind":"%s","reachable":true,' "$host" "$host" "$kind"
  printf '"desc":"%s","ramGB":%s,"vramGB":%s,' \
         "$(sed 's/"/\\"/g' <<<"${gpu:-${chip:-$model}}")" "${ram:-0}" "$vram_out"
  printf '"cores":%s,"wiredLimitMB":%s,' "${cores:-0}" "${wired:-0}"
  printf '"tegra":"%s","ollama":"%s",' "$tegra" "$ollama"
  printf '"bwGB":null,"bwMeasured":false}'   # filled in by measure-device.sh
}

echo "["
first=1
for h in "${HOSTS[@]}"; do
  [[ $first -eq 0 ]] && echo ","
  first=0
  if [[ $h == "$(hostname -s)" ]]; then
    out=$(bash -c "$REMOTE_PROBE" 2>/dev/null)
  else
    out=$(ssh "${SSH_OPTS[@]}" "$h" "$REMOTE_PROBE" 2>/dev/null)
  fi
  [[ -z $out ]] && echo "warn: $h unreachable" >&2
  emit_host "$h" "$out"
done
echo
echo "]"
