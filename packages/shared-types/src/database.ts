import type { Chain, Currency } from './enums.js';

export interface UserEntity {
  id: string;
  active_server_seed: string;
  previous_server_seed: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface WalletEntity {
  id: string;
  user_id: string;
  chain: Chain;
  currency: Currency;
  balance: string;
  current_nonce: number;
  wallet_address: string;
  created_at: Date;
  updated_at: Date;
}

export interface TransactionEntity {
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
  executed_at: Date;
}
