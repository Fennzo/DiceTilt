#!/bin/sh
# Start Anvil with state persistence.
# On first boot, no state file exists — start fresh.
# On subsequent boots, load the previously dumped state.
STATE_FILE="/data/anvil-state.json"

if [ -f "$STATE_FILE" ]; then
  echo "Loading Anvil state from $STATE_FILE"
  exec anvil --host 0.0.0.0 --dump-state "$STATE_FILE" --load-state "$STATE_FILE"
else
  echo "No previous Anvil state found — starting fresh chain"
  exec anvil --host 0.0.0.0 --dump-state "$STATE_FILE"
fi
