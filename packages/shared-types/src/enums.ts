export const Chain = {
  ETHEREUM: 'ethereum',
  SOLANA: 'solana',
} as const;
export type Chain = (typeof Chain)[keyof typeof Chain];

export const Currency = {
  ETH: 'ETH',
  SOL: 'SOL',
  USDC: 'USDC',
  USDT: 'USDT',
} as const;
export type Currency = (typeof Currency)[keyof typeof Currency];

export const BetDirection = {
  OVER: 'over',
  UNDER: 'under',
} as const;
export type BetDirection = (typeof BetDirection)[keyof typeof BetDirection];

export const KAFKA_TOPICS = {
  BET_RESOLVED: 'BetResolved',
  DEPOSIT_RECEIVED: 'DepositReceived',
  WITHDRAWAL_REQUESTED: 'WithdrawalRequested',
  WITHDRAWAL_COMPLETED: 'WithdrawalCompleted',
  TRADE_EXECUTED: 'TradeExecuted',
  BET_RESOLVED_DLQ: 'BetResolved-DLQ',
  DEPOSIT_RECEIVED_DLQ: 'DepositReceived-DLQ',
  WITHDRAWAL_COMPLETED_DLQ: 'WithdrawalCompleted-DLQ',
} as const;
