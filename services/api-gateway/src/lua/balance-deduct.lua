-- Atomic balance deduction + nonce increment
-- KEYS[1] = user:{userId}:balance:{chain}:{currency}
-- KEYS[2] = user:{userId}:nonce:{chain}:{currency}
-- ARGV[1] = wagerAmount (string)
--
-- Returns: {1, newBalance, newNonce} on success
--          {0, currentBalance, currentNonce} on insufficient balance

local balanceKey = KEYS[1]
local nonceKey = KEYS[2]
local wager = tonumber(ARGV[1])

local balance = tonumber(redis.call('GET', balanceKey) or '0')

if balance < wager then
  local nonce = tonumber(redis.call('GET', nonceKey) or '0')
  return {0, tostring(balance), tostring(nonce)}
end

local newBalance = balance - wager
redis.call('SET', balanceKey, tostring(newBalance))

local newNonce = redis.call('INCR', nonceKey)

return {1, tostring(newBalance), tostring(newNonce)}
