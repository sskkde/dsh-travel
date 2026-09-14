#!/bin/bash
# 运行三个宿主面 spike 并留证到 docs/evidence/m1/w1/。
# 依赖：node v22（原生 TS 剥离）、workspace node_modules 内 @deepseek-ai/* 宿主包 junction。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

EVIDENCE="docs/evidence/m1/w1"
mkdir -p "$EVIDENCE"

for spike in spike-webserver spike-credentials spike-settings; do
  echo "=== $spike ===" | tee "$EVIDENCE/$spike.txt"
  node "src/spikes/$spike.ts" 2>&1 | tee -a "$EVIDENCE/$spike.txt"
  echo "(exit ${PIPESTATUS[0]})" | tee -a "$EVIDENCE/$spike.txt"
done

echo "spikes done → $EVIDENCE"