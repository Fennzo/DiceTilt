#!/usr/bin/env bash
# =============================================================================
# run-stress-suite.sh — DiceTilt full stress test suite
#
# Runs all 5 load tests in ascending stress order, with a 60-second recovery
# window between each test so Kafka lag drains, Redis cools down, and
# PostgreSQL connections return to pool.
#
# Prerequisites:
#   - All DiceTilt containers healthy: docker compose ps
#   - k6 installed: /c/Program Files/k6/k6.exe  (Windows) or k6 in PATH
#   - TEST_MODE=true on api-gateway (default in docker-compose.yml)
#   - mkdir results/ if it doesn't exist
#
# Usage:
#   bash scripts/run-stress-suite.sh
#   bash scripts/run-stress-suite.sh --skip-to 3          # start from test 03
#   bash scripts/run-stress-suite.sh --only 4             # run only test 04
#   BASE_URL=http://localhost:3000 bash scripts/run-stress-suite.sh
#
# Output:
#   results/01-baseline-normal-summary.json
#   results/02-evening-peak-summary.json
#   results/03-traffic-spike-summary.json
#   results/04-whale-mixer-summary.json
#   results/05-peak-crush-summary.json
#   results/suite-run-$(date).log      — full console output of this run
# =============================================================================

set -euo pipefail

# ─── Config ───────────────────────────────────────────────────────────────────
BASE_URL="${BASE_URL:-http://localhost:3000}"
WS_URL="${WS_URL:-ws://localhost:3000/ws}"
RECOVERY_SECS=60   # pause between tests for system to recover

# Detect k6 binary
if command -v k6 &>/dev/null; then
  K6="k6"
elif [ -f "/c/Program Files/k6/k6.exe" ]; then
  K6="/c/Program Files/k6/k6.exe"
else
  echo "ERROR: k6 not found. Install from https://k6.io/docs/getting-started/installation/"
  exit 1
fi

# Parse args
SKIP_TO=1
ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-to)
      [[ -z "${2:-}" ]] && { echo "ERROR: --skip-to requires a value"; exit 1; }
      [[ "$2" =~ ^[1-5]$ ]] || { echo "ERROR: --skip-to must be 1-5"; exit 1; }
      SKIP_TO="$2"; shift 2 ;;
    --only)
      [[ -z "${2:-}" ]] && { echo "ERROR: --only requires a value"; exit 1; }
      [[ "$2" =~ ^[1-5]$ ]] || { echo "ERROR: --only must be 1-5"; exit 1; }
      ONLY="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# ─── Helpers ──────────────────────────────────────────────────────────────────
SUITE_START=$(date +%s)
LOG_FILE="results/suite-run-$(date +%Y%m%dT%H%M%S).log"
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

mkdir -p results

header() {
  local num="$1" title="$2" duration="$3"
  echo ""
  echo "████████████████████████████████████████████████████████████████████"
  echo "  TEST ${num}/5 — ${title}"
  echo "  Duration: ${duration}"
  echo "  Base URL: ${BASE_URL}"
  echo "  Started:  $(date '+%Y-%m-%d %H:%M:%S')"
  echo "████████████████████████████████████████████████████████████████████"
  echo ""
}

health_check() {
  echo "▶ Pre-test health check..."
  local gateway_status
  gateway_status=$(curl -sf "${BASE_URL}/health" 2>/dev/null | grep -c '"status"' || true)
  if [ "$gateway_status" -eq 0 ]; then
    echo "  WARNING: api-gateway /health did not respond. Containers may be down."
    echo "  Run: docker compose ps"
    echo "  Continuing anyway — k6 will report connection errors if service is down."
  else
    echo "  ✓ api-gateway healthy"
  fi
}

recovery_pause() {
  local secs="$1"
  echo ""
  echo "⏳ Recovery pause (${secs}s) — Kafka lag draining, Redis cooling, PG connections releasing..."
  for i in $(seq "$secs" -5 5); do
    printf "  %3ds remaining\r" "$i"
    sleep 5
  done
  echo "  Recovery complete.                  "
  echo ""
}

run_test() {
  local num="$1" file="$2" title="$3" duration="$4"

  if [ -n "$ONLY" ] && [ "$num" != "$ONLY" ]; then
    echo "⏭  Skipping test ${num} (--only ${ONLY})"
    SKIP_COUNT=$((SKIP_COUNT + 1))
    return
  fi
  if [ "$num" -lt "$SKIP_TO" ]; then
    echo "⏭  Skipping test ${num} (--skip-to ${SKIP_TO})"
    SKIP_COUNT=$((SKIP_COUNT + 1))
    return
  fi

  header "$num" "$title" "$duration"
  health_check

  local start_time
  start_time=$(date +%s)

  set +e
  "$K6" run \
    --env BASE_URL="${BASE_URL}" \
    --env WS_URL="${WS_URL}" \
    "${file}"
  local exit_code=$?
  set -e

  local elapsed=$(( $(date +%s) - start_time ))
  echo ""
  if [ $exit_code -eq 0 ]; then
    echo "  ✓ Test ${num} PASSED (${elapsed}s)"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  ✗ Test ${num} FAILED with exit code ${exit_code} (${elapsed}s)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

# ─── Pre-run banner ───────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════════════╗"
echo "║            DiceTilt Stress Suite — 5 Tests, Ascending Load          ║"
echo "╠══════════════════════════════════════════════════════════════════════╣"
echo "║  01  Baseline Normal     │  50 VUs constant       │  ~8 min          ║"
echo "║  02  Evening Peak        │  0→400 VUs ramp        │  ~9.5 min        ║"
echo "║  03  Traffic Spike       │  80→900 VUs spike      │  ~7 min          ║"
echo "║  04  Whale Mixer         │  250 VUs (3 tiers)     │  10 min          ║"
echo "║  05  Peak Crush          │  0→1000 VUs crush      │  ~13 min         ║"
echo "╠══════════════════════════════════════════════════════════════════════╣"
echo "║  Total (no skips):  ~50 min + 4 × 60s recovery = ~55 min            ║"
echo "╚══════════════════════════════════════════════════════════════════════╝"
echo ""
echo "  Logging to: ${LOG_FILE}"
echo "  Open Grafana at http://localhost:3030 to monitor in real time."
echo ""

# ─── Run tests ────────────────────────────────────────────────────────────────

run_test "1" "tests/load/01-baseline-normal.js" "BASELINE NORMAL (Quiet Hours)"      "~8 min"
[ "$ONLY" == "" ] && [ "$SKIP_TO" -le 1 ] && recovery_pause $RECOVERY_SECS

run_test "2" "tests/load/02-evening-peak.js"    "EVENING PEAK (Prime Time, 400 VUs)" "~9.5 min"
[ "$ONLY" == "" ] && [ "$SKIP_TO" -le 2 ] && recovery_pause $RECOVERY_SECS

run_test "3" "tests/load/03-traffic-spike.js"   "TRAFFIC SPIKE (Viral, 900 VUs)"     "~7 min"
[ "$ONLY" == "" ] && [ "$SKIP_TO" -le 3 ] && recovery_pause $RECOVERY_SECS

run_test "4" "tests/load/04-whale-mixer.js"     "WHALE MIXER (3-Tier Population)"    "10 min"
[ "$ONLY" == "" ] && [ "$SKIP_TO" -le 4 ] && recovery_pause $RECOVERY_SECS

run_test "5" "tests/load/05-peak-crush.js"      "PEAK CRUSH (Black Friday, 1000 VUs)" "~13 min"

# ─── Final summary ────────────────────────────────────────────────────────────
TOTAL_ELAPSED=$(( $(date +%s) - SUITE_START ))
TOTAL_MIN=$(( TOTAL_ELAPSED / 60 ))
TOTAL_SEC=$(( TOTAL_ELAPSED % 60 ))

echo ""
echo "╔══════════════════════════════════════════════════════════════════════╗"
echo "║                      SUITE COMPLETE                                  ║"
echo "╠══════════════════════════════════════════════════════════════════════╣"
printf "║  Passed  : %-60s║\n" "${PASS_COUNT}/5"
printf "║  Failed  : %-60s║\n" "${FAIL_COUNT}/5"
printf "║  Skipped : %-60s║\n" "${SKIP_COUNT}/5"
printf "║  Runtime : %-60s║\n" "${TOTAL_MIN}m ${TOTAL_SEC}s"
echo "╠══════════════════════════════════════════════════════════════════════╣"
echo "║  Result files: results/0[1-5]-*-summary.json                        ║"
echo "║  Full log:     ${LOG_FILE}"
echo "╚══════════════════════════════════════════════════════════════════════╝"
echo ""

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "  ✗ Suite completed with ${FAIL_COUNT} failure(s). Check the result files above."
  exit 1
else
  echo "  ✓ All tests passed."
  exit 0
fi
