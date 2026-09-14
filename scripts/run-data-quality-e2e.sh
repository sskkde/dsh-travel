#!/usr/bin/env bash
# run-data-quality-e2e.sh — T19 专项 qinggan 数据质量 e2e runner
#
# 默认（无参数 / offline）：离线确定性剧本契约测试
#   - 全 fixture 注入（渠道/正文抓取/geocoder/交通/天气/报价），零真实网络
#   - 驱动 tests/e2e/data-quality/scenario-contract.test.ts
#   - 产出证据 caller-loop.json + caller-loop.log（docs/evidence/qinggan-data-quality/w5/）
#   - PASS（exit 0）/ FAIL（exit 1）两态
#
# --live：真实调用方行为留证（gated）
#   - 前置条件：.test-env 可装配（DSH_HOME 可达、3081 端口可用）
#   - 驱动 tests/live-qinggan.test.ts（TRAVEL_LIVE_SMOKE=1）
#   - PASS（exit 0）/ BLOCKED（exit 2，live 条件缺失，不计入 pass）/ FAIL（exit 1）三态
#
# 生产 3080 全程零触碰：本脚本只接触 .test-env 与本地 vitest。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

MODE="${1:-offline}"
EVIDENCE_DIR="${QG_EVIDENCE_DIR:-$REPO/docs/evidence/qinggan-data-quality/w5}"

echo "== dsh-travel qinggan data-quality e2e | mode=${MODE} | cwd=${REPO}"

case "$MODE" in
  offline|--offline|'')
    export QG_E2E_MODE=offline
    export QG_EVIDENCE_DIR="$EVIDENCE_DIR"
    mkdir -p "$EVIDENCE_DIR"
    # 离线契约：fixture 注入、零真实网络；不要求 3081
    npx vitest run tests/e2e/data-quality/
    echo "== OFFLINE_CONTRACT_PASS（证据：${EVIDENCE_DIR}/caller-loop.{json,log}）"
    exit 0
    ;;
  --live|live)
    export TRAVEL_LIVE_SMOKE=1
    export QG_E2E_MODE=live
    export QG_EVIDENCE_DIR="$EVIDENCE_DIR"
    mkdir -p "$EVIDENCE_DIR"

    # ── live 前置条件检查（任一缺失 → BLOCKED，exit 2；blocked 不进 pass） ──
    if [ ! -d "$REPO/.test-env" ]; then
      echo "BLOCKED: .test-env 目录缺失（未按 README 装配测试环境）" >&2
      exit 2
    fi
    if [ ! -f "$REPO/.test-env/dsh-home/.credentials.yaml" ]; then
      echo "BLOCKED: .test-env/dsh-home/.credentials.yaml 缺失（测试环境凭据未就绪）" >&2
      exit 2
    fi
    # 3081 可用性：读 status；未运行则按 README 口径启动测试实例（仅 .test-env）
    if .test-env/start.sh status | grep -q '^running:'; then
      echo "== live: .test-env 实例已运行（复用）"
    else
      echo "== live: .test-env 实例未运行，按 README 口径启动（仅测试环境）"
      if ! .test-env/start.sh start >/dev/null 2>&1; then
        echo "BLOCKED: 3081 测试实例启动失败（见 .test-env/instance.log）" >&2
        exit 2
      fi
    fi
    PORT="${TRAVEL_TEST_PORT:-3081}"
    ready=0
    for _ in $(seq 1 60); do
      if curl --fail --silent --show-error --max-time 1 "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
        ready=1
        break
      fi
      sleep 0.5
    done
    if [ "$ready" -ne 1 ]; then
      echo "BLOCKED: 3081 就绪超时（curl 未通过）" >&2
      exit 2
    fi

    DSH_HOME="$REPO/.test-env/dsh-home"
    export DSH_HOME
    export DSH_TRAVEL_ROOT="${DSH_TRAVEL_ROOT:-$REPO/.test-env/live-qinggan}"
    mkdir -p "$DSH_TRAVEL_ROOT"

    if npx vitest run tests/live-qinggan.test.ts; then
      echo "== LIVE_PASS（DSH_TRAVEL_ROOT=${DSH_TRAVEL_ROOT}）"
      exit 0
    fi
    echo "== LIVE_FAIL（见上方 vitest 输出；不把失败当 pass）" >&2
    exit 1
    ;;
  *)
    echo "usage: bash scripts/run-data-quality-e2e.sh [offline|--live]" >&2
    exit 3
    ;;
esac