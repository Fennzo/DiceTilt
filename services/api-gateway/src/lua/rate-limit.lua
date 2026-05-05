local key = KEYS[1]
local limit = tonumber(ARGV[1])
local ttlMs = tonumber(ARGV[2])
local count = tonumber(redis.call('INCR', key))

if count == 1 then
  redis.call('PEXPIRE', key, ttlMs)
end

if count > limit then
  return 0
end

return 1
