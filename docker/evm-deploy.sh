#!/bin/sh
# Deploy Treasury to Anvil and write contract address to /shared/treasury-addr.
# Idempotent: if treasury-addr already contains an address that has live bytecode
# on-chain, skip redeployment and reuse the existing contract.
# This prevents a second deployment (at nonce=1, different address) when Docker
# Compose re-runs this one-shot container because a dependent service was recreated.
set -e
RPC="${EVM_RPC_URL:-http://evm-node:8545}"
PK="${TREASURY_OWNER_PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"

echo "Waiting for Anvil at $RPC..."
for i in 1 2 3 4 5 6 7 8 9 10; do
  if wget -qO- --post-data='{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' --header='Content-Type: application/json' "$RPC" 2>/dev/null | grep -q result; then
    break
  fi
  sleep 2
done

# --- Idempotency check -------------------------------------------------------
# If the shared file already has an address AND that contract has live bytecode
# on the current chain, reuse it without redeploying.
if [ -d /shared ] && [ -f /shared/treasury-addr ]; then
  EXISTING=$(cat /shared/treasury-addr | tr -d '[:space:]' | tr -d '\n')
  if [ -n "$EXISTING" ]; then
    CODE=$(wget -qO- \
      --post-data="{\"jsonrpc\":\"2.0\",\"method\":\"eth_getCode\",\"params\":[\"$EXISTING\",\"latest\"],\"id\":1}" \
      --header='Content-Type: application/json' "$RPC" 2>/dev/null || true)
    # eth_getCode returns "0x" for an EOA / non-existent contract
    if echo "$CODE" | grep -q '"result"' && ! echo "$CODE" | grep -q '"result":"0x"'; then
      echo "Deployed Treasury at $EXISTING (already deployed — skipping redeploy)"
      exit 0
    fi
    echo "Contract at $EXISTING has no bytecode (chain reset?) — redeploying..."
  fi
fi
# -----------------------------------------------------------------------------

cd /app
npx hardhat compile 2>/dev/null || true
ADDR=""
for i in 1 2 3 4 5; do
  OUT=$(npx hardhat run scripts/deploy.js --network local 2>&1)
  if [ $? -eq 0 ] && [ -n "$OUT" ]; then
    ADDR=$(echo "$OUT" | tail -1)
    break
  fi
  echo "Deploy attempt $i failed: $OUT"
  sleep 3
done
if [ -n "$ADDR" ] && [ -d /shared ]; then
  echo "$ADDR" > /shared/treasury-addr
  echo "Deployed Treasury at $ADDR"
else
  echo "ERROR: Failed to deploy Treasury or /shared not available"
  exit 1
fi
