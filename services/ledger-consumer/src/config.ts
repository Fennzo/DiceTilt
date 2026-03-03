export const config = {
  kafkaBrokers: (process.env.KAFKA_BROKERS || 'localhost:29092').split(','),
  kafkaGroupId: process.env.KAFKA_GROUP_ID || process.env.LEDGER_KAFKA_GROUP_ID || 'ledger-persistent-group',
  dbUrl: process.env.DATABASE_URL || 'postgresql://dicetilt:dicetilt_dev_pass@localhost:5432/dicetilt',
  redisUri: process.env.REDIS_URI || 'redis://localhost:6379',
};
