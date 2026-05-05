local key = KEYS[1]
local limit = tonumber(ARGV[1])
local ttlSec = tonumber(ARGV[2])
local n = tonumber(redis.call('INCR', key))
if n > limit then
  redis.call('DECR', key)
  local left = tonumber(redis.call('GET', key) or '0')
  if left <= 0 then
    redis.call('DEL', key)
  end
  return 0
end
if ttlSec > 0 then
  redis.call('EXPIRE', key, ttlSec)
end
return 1
