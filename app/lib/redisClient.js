const redisClient = require('redis');
const client = redisClient.createClient(process.env.REDIS_PORT, process.env.REDIS_HOST);

module.exports = client;
