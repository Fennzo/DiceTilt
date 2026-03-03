-- Atomic balance credit (payout on win)
-- KEYS[1] = user:{userId}:balance:{chain}:{currency}
-- ARGV[1] = payoutAmount (string)
--
-- Returns: newBalance

local balanceKey = KEYS[1]
local payout = tonumber(ARGV[1])

local balance = tonumber(redis.call('GET', balanceKey) or '0')
local newBalance = balance + payout
redis.call('SET', balanceKey, tostring(newBalance))

return tostring(newBalance)
