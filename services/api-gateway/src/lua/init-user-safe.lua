local balanceEth  = KEYS[1]
local balanceSol  = KEYS[2]
local escrowEth   = KEYS[3]
local escrowSol   = KEYS[4]
local nonceEth    = KEYS[5]
local nonceSol    = KEYS[6]
local serverSeed  = KEYS[7]
local ethBal      = ARGV[1]
local solBal      = ARGV[2]
local seed        = ARGV[3]

-- Only SET balance when key is absent (Redis restart/eviction recovery).
-- When key exists, Redis is more current: it processes bets synchronously in Lua
-- while Postgres has ~100ms Kafka lag for bet P&L updates.
if redis.call('GET', balanceEth) == false then
  redis.call('SET', balanceEth, ethBal)
end
if redis.call('GET', balanceSol) == false then
  redis.call('SET', balanceSol, solBal)
end

-- Preserve nonce when key exists (provably-fair chain integrity).
-- Previously, nonce was reset to 0 when escrow=0, which broke the nonce chain
-- during the window between bet settlement and the next bet.
if redis.call('GET', nonceEth) == false then
  redis.call('SET', nonceEth, '0')
end
if redis.call('GET', nonceSol) == false then
  redis.call('SET', nonceSol, '0')
end

-- Only zero escrow when it's currently zero (don't overwrite in-flight bet escrow).
local eEth = tonumber(redis.call('GET', escrowEth) or '0') or 0
if eEth == 0 then
  redis.call('SET', escrowEth, '0')
end
local eSol = tonumber(redis.call('GET', escrowSol) or '0') or 0
if eSol == 0 then
  redis.call('SET', escrowSol, '0')
end

-- Server seed always updated (managed by auth server, not race-prone).
redis.call('SET', serverSeed, seed)
return 1
