local balanceKey = KEYS[1]
local amount     = tonumber(ARGV[1])
local balanceStr = redis.call('GET', balanceKey) or '0'
local balance    = tonumber(balanceStr)
if balance < amount then
  return {0, balanceStr}
end
local newBalance = balance - amount
redis.call('SET', balanceKey, tostring(newBalance))
return {1, tostring(newBalance)}
