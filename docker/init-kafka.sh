#!/bin/bash
set -e

KAFKA_BIN="/opt/kafka/bin"

echo "Waiting for Kafka to be ready..."
until ${KAFKA_BIN}/kafka-topics.sh --bootstrap-server kafka:29092 --list > /dev/null 2>&1; do
  echo "Kafka not ready yet, retrying in 2s..."
  sleep 2
done
echo "Kafka is ready."

KAFKA_TOPICS=(
  "BetResolved"
  "DepositReceived"
  "WithdrawalRequested"
  "WithdrawalCompleted"
  "TradeExecuted"
  "BetResolved-DLQ"
  "DepositReceived-DLQ"
  "WithdrawalCompleted-DLQ"
)

for topic in "${KAFKA_TOPICS[@]}"; do
  ${KAFKA_BIN}/kafka-topics.sh \
    --bootstrap-server kafka:29092 \
    --create \
    --if-not-exists \
    --topic "$topic" \
    --partitions 3 \
    --replication-factor 1
  echo "Topic created or already exists: $topic"
done

echo "All ${#KAFKA_TOPICS[@]} topics ready."
