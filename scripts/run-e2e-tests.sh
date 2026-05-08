#!/usr/bin/env bash
# =============================================================================
# run-e2e-tests.sh — DiceTilt full E2E integration test suite
#
# Runs all 4 integration test files sequentially, each covering a different
# aspect of the bet / deposit / withdrawal lifecycle:
#
#   1. balance-accuracy     — Bet accuracy (ETH + SOL), deposit accuracy,
#                             consecutive deposits, WS ↔ GET /balance agreement
#   2. balance-update-timing— Withdrawal deduction timing, deposit idempotency,
#                             WS signal delivery (BALANCE_UPDATE, WITHDRAWAL_COMPLETED)
#   3. dw-status-flow       — UI-gating WS signals: deposit flow, withdrawal flow,
#                             each step transitions the frontend status correctly
#   4. full-user-behavior-qa— End-to-end user flow: bet matrix, ETH deposit,
#                             ETH withdrawal, SOL rejection, PF seed rotation
#
# Prerequisites:
#   - docker compose up -d  (all 14 containers healthy)
#   - TEST_MODE=true on api-gateway (default in docker-compose.yml)
#   - Anvil running on localhost:8545 with unlocked Hardhat accounts
#   - Node.js 18+ (ESM support)
#   - ws package installed (pnpm install)
#
# Usage:
#   bash scripts/run-e2e-tests.sh
#   bash scripts/run-e2e-tests.sh --base-url http://localhost:3000
#   bash scripts/run-e2e-tests.sh --skip-to 3        # skip tests 1 and 2
#   bash scripts/run-e2e-tests.sh --only 4            # run only test 4
#
# Exit code:
#   0 — all tests passed
#   1 — one or more tests failed
# =============================================================================

set -euo pipefail

# ─── Config ───────────────────────────────────────────────────────────────────
BASE_URL="${BASE_URL:-http://localhost:3000}"
SKIP_TO=1
ONLY=""

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url=*)
      BASE_URL="${1#--base-url=}"
      shift ;;
    --base-url)
      BASE_URL="${2:-}"
      shift 2 ;;
    --skip-to)
      [[ -z "${2:-}" ]] && { echo "ERROR: --skip-to requires a value (1-4)"; exit 1; }
      [[ "$2" =~ ^[1-4]$ ]] || { echo "ERROR: --skip-to must be 1-4"; exit 1; }
      SKIP_TO="$2"; shift 2 ;;
    --only)
      [[ -z "${2:-}" ]] && { echo "ERROR: --only requires a value (1-4)"; exit 1; }
      [[ "$2" =~ ^[1-4]$ ]] || { echo "ERROR: --only must be 1-4"; exit 1; }
      ONLY="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: bash scripts/run-e2e-tests.sh [--base-url URL] [--skip-to N] [--only N]"
      echo ""
      echo "Runs all 4 DiceTilt E2E integration tests:"
      echo "  1. balance-accuracy      — bet + deposit balance correctness"
      echo "  2. balance-update-timing — withdrawal/deduction timing, deposit idempotency"
      echo "  3. dw-status-flow        — deposit/withdrawal UI-gating WS signals"
      echo "  4. full-user-behavior-qa — complete user flow (bet, deposit, withdraw, PF)"
      exit 0 ;;
    *)
      echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# ─── Helpers ──────────────────────────────────────────────────────────────────
SUITE_START=$(date +%s)
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

header() {
  local num="$1" title="$2"
  echo ""
  echo "══════════════════════════════════════════════════════════════════════"
  echo "  TEST ${num}/4 — ${title}"
  echo "  Base URL: ${BASE_URL}"
  echo "  Started:  $(date '+%Y-%m-%d %H:%M:%S')"
  echo "══════════════════════════════════════════════════════════════════════"
  echo ""
}

run_test() {
  local num="$1" file="$2" title="$3"

  if [ -n "$ONLY" ] && [ "$num" != "$ONLY" ]; then
    echo "  ⏭  Skipping test ${num} (--only ${ONLY})"
    SKIP_COUNT=$((SKIP_COUNT + 1))
    return
  fi
  if [ "$num" -lt "$SKIP_TO" ]; then
    echo "  ⏭  Skipping test ${num} (--skip-to ${SKIP_TO})"
    SKIP_COUNT=$((SKIP_COUNT + 1))
    return
  fi

  header "$num" "$title"

  local start_time
  start_time=$(date +%s)

  set +e
  node "$file" --base-url="${BASE_URL}"
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

# ─── Preflight ────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════════════╗"
echo "║          DiceTilt E2E Integration Test Suite — 4 Tests               ║"
echo "╠══════════════════════════════════════════════════════════════════════╣"
echo "║  1  balance-accuracy      │  Bet + deposit balance correctness       ║"
echo "║  2  balance-update-timing│  Withdrawal timing, deposit idempotency   ║"
echo "║  3  dw-status-flow       │  UI-gating deposit/withdrawal signals   ║"
echo "║  4  full-user-behavior-qa│  Full user flow (bet+deposit+withdraw+PF) ║"
echo "╚══════════════════════════════════════════════════════════════════════╝"
echo ""
echo "  Base URL: ${BASE_URL}"
echo ""

# Health check
echo "  ▶ Pre-flight health check..."
GATEWAY_OK=false
if curl -sf "${BASE_URL}/health" >/dev/null 2>&1; then
  GATEWAY_OK=true
  echo "  ✓ api-gateway healthy"
else
  echo "  ✗ api-gateway /health did not respond!"
  echo "    Run: docker compose ps"
  echo "    Ensure all containers are healthy before running E2E tests."
  exit 1
fi

# Anvil check (deposit/withdrawal tests need it)
ANVIL_OK=false
if curl -sf -X POST http://localhost:8545 -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' 2>/dev/null | grep -q "result"; then
  ANVIL_OK=true
  echo "  ✓ Anvil EVM node reachable"
else
  echo "  ⚠  Anvil not reachable at localhost:8545 — deposit/withdrawal tests may fail"
fi

echo ""

# ─── Run tests ────────────────────────────────────────────────────────────────

run_test "1" "tests/balance-accuracy.js"        "BALANCE ACCURACY (Bet + deposit correctness)"
run_test "2" "tests/balance-update-timing.js"   "BALANCE UPDATE TIMING (Withdrawal + deposit signals)"
run_test "3" "tests/dw-status-flow.js"          "DEPOSIT/WITHDRAWAL STATUS FLOW (UI-gating WS signals)"
run_test "4" "tests/full-user-behavior-qa.js"   "FULL USER BEHAVIOR QA (Bet + deposit + withdraw + PF)"

# ─── Final summary ────────────────────────────────────────────────────────────
TOTAL_ELAPSED=$(( $(date +%s) - SUITE_START ))
TOTAL_MIN=$(( TOTAL_ELAPSED / 60 ))
TOTAL_SEC=$(( TOTAL_ELAPSED % 60 ))

echo ""
echo "╔══════════════════════════════════════════════════════════════════════╗"
echo "║                      E2E SUITE COMPLETE                              ║"
echo "╠══════════════════════════════════════════════════════════════════════╣"
printf "║  Passed  : %-56s║  " "${PASS_COUNT}/4"
echo ""
printf "║  Failed  : %-56s║  " "${FAIL_COUNT}/4"
echo ""
printf "║  Skipped : %-56s║  " "${SKIP_COUNT}/4"
echo ""
printf "║  Runtime : %-56s║  " "${TOTAL_MIN}m ${TOTAL_SEC}s"
echo ""
echo "╚══════════════════════════════════════════════════════════════════════╝"
echo ""

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "  ✗ Suite completed with ${FAIL_COUNT} failure(s). Review output above."
  exit 1
else
  echo "  ✓ All E2E tests passed."
  exit 0
fi
