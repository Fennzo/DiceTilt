import type { Chain, Currency } from './enums.js';

export interface BetResolvedEvent {
  bet_id: string;
  user_id: string;
  chain: Chain;
  currency: Currency;
  wager_amount: string;
  payout_amount: string;
  game_result: number;
  client_seed: string;
  nonce_used: number;
  outcome_hash: string;
  executed_at: string;
}

export interface DepositReceivedEvent {
  deposit_id: string;
  user_id: string;
  chain: Chain;
  currency: Currency;
  amount: string;
  wallet_address: string;
  tx_hash: string;
  block_number: number;
  deposited_at: string;
}

export interface WithdrawalRequestedEvent {
  withdrawal_id: string;
  user_id: string;
  chain: Chain;
  currency: Currency;
  amount: string;
  to_address: string;
  requested_at: string;
}

export interface WithdrawalCompletedEvent {
  withdrawal_id: string;
  user_id: string;
  chain: Chain;
  currency: Currency;
  amount: string;
  to_address: string;
  tx_hash: string;
  completed_at: string;
}

export interface TradeExecutedEvent {
  trade_id: string;
  user_id: string;
  chain: Chain;
  trade_pair: string;
  input_amount: string;
  output_amount: string;
  execution_price: string;
  slippage_bps: number;
  mev_savings_usd: string;
  jito_bundle_id?: string;
  executed_at: string;
}

export interface DeadLetterMessage {
  original_topic: string;
  original_payload: BetResolvedEvent | DepositReceivedEvent | WithdrawalCompletedEvent;
  error_message: string;
  error_stack?: string;
  retry_count: number;
  failed_at: string;
}
