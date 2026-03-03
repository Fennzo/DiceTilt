import type { Chain, Currency, BetDirection } from './enums.js';

export enum WebSocketErrorCode {
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  INVALID_PAYLOAD = 'INVALID_PAYLOAD',
  RATE_LIMITED = 'RATE_LIMITED',
  SEED_REQUIRED = 'SEED_REQUIRED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

export interface BetResultMessage {
  type: 'BET_RESULT';
  betId: string;
  gameResult: number;
  gameHash: string;
  nonce: number;
  wagerAmount: number;
  payoutAmount: number;
  target: number;
  direction: BetDirection;
  multiplier: number;
  newBalance: number;
  chain: Chain;
  currency: Currency;
  timestamp: string;
}

export interface BalanceUpdateMessage {
  type: 'BALANCE_UPDATE';
  balance: number;
  chain: Chain;
  currency: Currency;
}

export interface WithdrawalCompletedMessage {
  type: 'WITHDRAWAL_COMPLETED';
  withdrawalId: string;
  chain: Chain;
  currency: Currency;
  txHash: string;
  amount: string;
}

export interface ErrorMessage {
  type: 'ERROR';
  code: WebSocketErrorCode;
  message: string;
}

export interface PongMessage {
  type: 'PONG';
}

export interface SessionRevokedMessage {
  type: 'SESSION_REVOKED';
}

export type ServerMessage =
  | BetResultMessage
  | BalanceUpdateMessage
  | WithdrawalCompletedMessage
  | ErrorMessage
  | PongMessage
  | SessionRevokedMessage;
