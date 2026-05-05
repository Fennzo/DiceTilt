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

redis.call('SET', balanceEth, ethBal)
redis.call('SET', balanceSol, solBal)

local eEth = tonumber(redis.call('GET', escrowEth) or '0') or 0
if eEth == 0 then
  redis.call('SET', escrowEth, '0')
end

local eSol = tonumber(redis.call('GET', escrowSol) or '0') or 0
if eSol == 0 then
  redis.call('SET', escrowSol, '0')
end

if eEth == 0 then
  redis.call('SET', nonceEth, '0')
end
if eSol == 0 then
  redis.call('SET', nonceSol, '0')
end
redis.call('SET', serverSeed, seed)
return 1
