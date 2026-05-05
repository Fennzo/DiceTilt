local balanceKey = KEYS[1]
local amount     = tonumber(ARGV[1])
local balance    = tonumber(redis.call('GET', balanceKey) or '0')
local newBalance = balance + amount
redis.call('SET', balanceKey, tostring(newBalance))
return tostring(newBalance)
