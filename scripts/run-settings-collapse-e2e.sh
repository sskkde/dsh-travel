#!/usr/bin/env bash
set -euo pipefail

started=0
cleanup() {
  if [ "$started" -eq 1 ]; then
    .test-env/start.sh stop >/dev/null
  fi
}
trap cleanup EXIT INT TERM

if .test-env/start.sh status | grep -q '^running:'; then
  : # Reuse an already-running isolated test instance.
else
  .test-env/start.sh start
  started=1
fi

port="${TRAVEL_TEST_PORT:-3081}"
ready=0
for _ in $(seq 1 60); do
  if curl --fail --silent --show-error --max-time 1 "http://127.0.0.1:${port}/" >/dev/null; then
    ready=1
    break
  fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  echo "isolated DSH did not become ready on port ${port}" >&2
  exit 1
fi

node tests/e2e/settings-collapse.mjs
