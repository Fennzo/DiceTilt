local key = KEYS[1]
local v = redis.call('GET', key)
if not v or tonumber(v) <= 0 then
  return 0
end
redis.call('DECR', key)
local left = redis.call('GET', key)
if not left or tonumber(left) <= 0 then
  redis.call('DEL', key)
end
return 1
