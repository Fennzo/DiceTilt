#!/bin/sh
set -e
# Start Anvil in background, deploy Treasury, then foreground Anvil
anvil --host 0.0.0.0 &
ANVIL_PID=$!
sleep 3
# Deploy contract and write address to shared volume
cd /app/contracts/evm 2>/dev/null || cd /contracts/evm 2>/dev/null || true
if [ -f "package.json" ]; then
  npm install --silent 2>/dev/null || true
  npx hardhat compile 2>/dev/null || true
  ADDR=$(npx hardhat run scripts/deploy.js --network local 2>/dev/null || echo "")
  if [ -n "$ADDR" ] && [ -d /shared ]; then
    echo "$ADDR" > /shared/treasury-addr
  fi
fi
# Replace this process with anvil (foreground)
exec anvil --host 0.0.0.0
