import type { Chain, Currency } from './enums.js';

export interface AuthChallengeResponse {
  nonce: string;
}

export interface AuthVerifyRequest {
  walletAddress: string;
  signature: string;
}

export interface AuthVerifyResponse {
  token: string;
}

export interface WithdrawRequest {
  amount: number;
  chain: Chain;
  currency: Currency;
}

export interface WithdrawResponse {
  withdrawalId: string;
  status: 'PENDING';
}

export interface PfGenerateSeedResponse {
  serverSeed: string;
  commitment: string;
}

export interface PfCalculateRequest {
  clientSeed: string;
  nonce: number;
  serverSeed: string;
}

export interface PfCalculateResponse {
  gameResult: number;
  gameHash: string;
}

export interface PfRotateSeedRequest {
  currentServerSeed: string;
}

export interface PfRotateSeedResponse {
  revealedSeed: string;
  newServerSeed: string;
  newCommitment: string;
}

export interface PfStatusResponse {
  serverCommitment: string;
  currentNonce: number;
}
