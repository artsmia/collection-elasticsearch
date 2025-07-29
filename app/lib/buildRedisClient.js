const redis = require('redis');

function buildRedisClient() {
  return redis.createClient({
    url: process.env.REDIS_URL,
  });
}

module.exports = buildRedisClient;
