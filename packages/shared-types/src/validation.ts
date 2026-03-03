import { z } from 'zod';

export const ChainSchema = z.enum(['ethereum', 'solana']);
export const CurrencySchema = z.enum(['ETH', 'SOL', 'USDC', 'USDT']);
export const BetDirectionSchema = z.enum(['over', 'under']);

export const BetRequestSchema = z.object({
  type: z.literal('BET_REQUEST'),
  wagerAmount: z.number().positive().finite(),
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

export const AuthVerifyRequestSchema = z.object({
  walletAddress: z.string().min(1),
  signature: z.string().min(1),
});

export const AuthVerifyResponseSchema = z.object({
  token: z.string().min(1),
});

export const WithdrawRequestSchema = z.object({
  amount: z.number().positive().finite(),
  chain: ChainSchema,
  currency: CurrencySchema,
});

export const PfCalculateRequestSchema = z.object({
  clientSeed: z.string().min(1).max(64),
  nonce: z.number().int().nonnegative(),
  serverSeed: z.string().length(64),
});

export const PfRotateSeedRequestSchema = z.object({
  currentServerSeed: z.string().length(64),
});
