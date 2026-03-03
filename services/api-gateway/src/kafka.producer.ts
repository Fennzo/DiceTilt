import { Kafka, type Producer } from 'kafkajs';
import { config } from './config.js';
import { KAFKA_TOPICS, type BetResolvedEvent, type WithdrawalRequestedEvent } from '@dicetilt/shared-types';

const kafka = new Kafka({
  clientId: 'api-gateway',
  brokers: config.kafkaBrokers,
});

let producer: Producer;

export async function connectProducer(): Promise<void> {
  producer = kafka.producer({ idempotent: true });
  await producer.connect();
  console.log('[Kafka] Producer connected');
}

export async function disconnectProducer(): Promise<void> {
  if (producer) {
    await producer.disconnect();
    console.log('[Kafka] Producer disconnected');
  }
}

export async function produceBetResolved(event: BetResolvedEvent): Promise<void> {
  await producer.send({
    topic: KAFKA_TOPICS.BET_RESOLVED,
    acks: -1,
    messages: [
      {
        key: event.user_id,
        value: JSON.stringify(event),
      },
    ],
  });
}

export async function produceWithdrawalRequested(event: WithdrawalRequestedEvent): Promise<void> {
  await producer.send({
    topic: KAFKA_TOPICS.WITHDRAWAL_REQUESTED,
    acks: -1,
    messages: [
      {
        key: event.user_id,
        value: JSON.stringify(event),
      },
    ],
  });
}
