local balanceKey  = KEYS[1]
local escrowKey   = KEYS[2]
local wager       = tonumber(ARGV[1])
local escrowed    = tonumber(redis.call('GET', escrowKey) or '0')
local newEscrowed = math.max(0, escrowed - wager)
redis.call('SET', escrowKey, tostring(newEscrowed))
local balance    = tonumber(redis.call('GET', balanceKey) or '0')
local newBalance = balance + wager
redis.call('SET', balanceKey, tostring(newBalance))
return {tostring(newBalance), tostring(newEscrowed)}
