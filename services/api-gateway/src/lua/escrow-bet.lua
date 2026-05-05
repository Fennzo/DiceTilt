local balanceKey  = KEYS[1]
local escrowKey   = KEYS[2]
local nonceKey    = KEYS[3]
local wager       = tonumber(ARGV[1])
local balanceStr  = redis.call('GET', balanceKey) or '0'
local balance     = tonumber(balanceStr)
if balance < wager then
  local nonceStr  = redis.call('GET', nonceKey)  or '0'
  local escrowStr = redis.call('GET', escrowKey) or '0'
  return {0, balanceStr, escrowStr, nonceStr}
end
local newBalance  = balance - wager
redis.call('SET', balanceKey, tostring(newBalance))
local escrowed    = tonumber(redis.call('GET', escrowKey) or '0')
local newEscrowed = escrowed + wager
redis.call('SET', escrowKey, tostring(newEscrowed))
local newNonce = redis.call('INCR', nonceKey)
return {1, tostring(newBalance), tostring(newEscrowed), tostring(newNonce)}
