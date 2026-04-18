import { z } from 'zod';

export const ChainSchema = z.enum(['ethereum', 'solana']);
export const CurrencySchema = z.enum(['ETH', 'SOL', 'USDC', 'USDT']);
export const BetDirectionSchema = z.enum(['over', 'under']);

export const BetRequestSchema = z.object({
  type: z.literal('BET_REQUEST'),
  wagerAmount: z.number().positive().finite().max(50),   // max 50 units per bet
  clientSeed: z.string().min(1).max(64),
  chain: ChainSchema,
  currency: CurrencySchema,
  target: z.number().int().min(2).max(98),
  direction: BetDirectionSchema,
});
export type BetRequest = z.infer<typeof BetRequestSchema>;

export const PingSchema = z.object({
  type: z.literal('PING'),
});

export const ClientMessageSchema = z.discriminatedUnion('type', [
  BetRequestSchema,
  PingSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const AuthChallengeResponseSchema = z.object({
  nonce: z.string().uuid(),
});

// EVM address: 0x prefix + 40 hex chars, case-insensitive
const EvmAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'Invalid Ethereum address format');

export const AuthVerifyRequestSchema = z.object({
  walletAddress: EvmAddressSchema,
  signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/, 'Invalid signature format'),
  // The nonce issued by /api/v1/auth/challenge — must be signed by the wallet.
  // Prevents replay attacks: signature binds to this one-time server-issued value.
  nonce: z.string().uuid('Nonce must be a valid UUID'),
});

export const AuthVerifyResponseSchema = z.object({
  token: z.string().min(1),
});

export const WithdrawRequestSchema = z.object({
  amount: z.number().positive().finite().min(0.001).max(100), // min dust, max 100 units per withdrawal
  chain: ChainSchema,
  currency: CurrencySchema,
});

// First-frame WebSocket authentication message — token is never transmitted in the URL.
export const AuthMessageSchema = z.object({
  type: z.literal('AUTH'),
  token: z.string().min(1),
});

export const PfCalculateRequestSchema = z.object({
  clientSeed: z.string().min(1).max(64),
  nonce: z.number().int().min(0).max(1000000),
  serverSeed: z.string().length(64),
});

export const PfRotateSeedRequestSchema = z.object({
  currentServerSeed: z.string().length(64),
});

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('BET_RESULT'),
    betId: z.string().uuid(),
    gameResult: z.number(),
    gameHash: z.string(),
    nonce: z.number(),
    wagerAmount: z.number(),
    payoutAmount: z.number(),
    target: z.number(),
    direction: BetDirectionSchema,
    multiplier: z.number(),
    newBalance: z.number(),
    chain: ChainSchema,
    currency: CurrencySchema,
    timestamp: z.string().datetime(),
  }),
  z.object({
    type: z.literal('BALANCE_UPDATE'),
    balance: z.number(),
    chain: ChainSchema,
    currency: CurrencySchema,
  }),
  z.object({
    type: z.literal('WITHDRAWAL_COMPLETED'),
    withdrawalId: z.string().uuid(),
    chain: ChainSchema,
    currency: CurrencySchema,
    txHash: z.string(),
    amount: z.string(),
  }),
  z.object({
    type: z.literal('ERROR'),
    code: z.string(),
    message: z.string(),
  }),
  z.object({ type: z.literal('PONG') }),
  z.object({ type: z.literal('SESSION_REVOKED') }),
  z.object({ type: z.literal('AUTH_OK') }),
]);

