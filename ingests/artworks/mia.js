/** @format
 *
 * This script defines the ingest for Mia artwork data
 *
 * And output it to [ ] ElasticSearch, [ ] Github, [ ] Wikidata?, [ ] ???
 */

/**
 * # Step 1: Get the data from redis
 *
 * Data is in redis with a 'bucket' structure: `redis-cli hgetall objects:0`
 * gets all the objects in bucket `0`. Objects are "bucketed" based on their
 * `object ID`/1000.
 */

const Redis = require('async-redis')
const redis = Redis.createClient()
// const AsyncRedis = require('async-redis')
// const asyncRedis = AsyncRedis.decorate(redis)
const ioredis = require('ioredis')

// reads the data all at once
async function read(args = {}) {
  const allBuckets = (await redis.keys('object:*'))
    .map(bucketString => Number(bucketString.replace('object:', '')))
    .sort((a, b) => a - b)
  const buckets =
    args.buckets === 0 || args.buckets ? [args.buckets].flat() : allBuckets

  console.info('artworks/mia read', { args, buckets })

  buckets.map(async bucket => {
    // returns an object with all the artworks in this bucket
    //
    //     { id<String>: data<String>, … }
    const objectsRaw = await redis.hgetall(`object:${bucket}`)
    const objects = Object.values(objectsRaw).map(o => {
      try {
        return JSON.parse(o)
      } catch (e) {}
    })

    // OK, now what to do with the artwork data?
    //
    // Should this be a generator that's called somewhere else?
    // Or a readable stream with each artwork as a chunk>?
    // Or an event emitter that pings out each artwork?
    //
    // Does it even need to be async? The bottleneck isn't reading
    // from redis, it's probably sending into ES
    console.info(bucket, objects.length, objects[0].title)
  })
}
// other name ideas: "bulk"/"readBulk"? "pull"? "get"?

// sets up a stream of incoming data and listens for changes
//
// how to end the stream?
//
// ioredis is what I've used to do this in the past, but presumably normal
// redis can also handle it and that would mean using one fewer redis dep
function stream() {
  const ioredis = new require('ioredis')
  ioredis.monitor((err, monitor) => {
    monitor.on('monitor', (time, args) => {
      if (args[0].match(/hm?set/)) {
        // catch hset and hmset
        var [_, bucket, id, rawJson] = args

        // see above for 'now what?' question pass this data on for processing
        console.info({ bucket, id, rawJson })
      }
    })
  })
}
// "readStream"? "sync"?

module.exports = { read, stream }

/**
 * # Step 2: Normalize the data
 *
 * There are some idiosyncracies in the Mia artwork API around character
 * encoding and artist name that need to be ironed out. See the numerous
 * replacements made with `sed` in the existing `streamRedis` command in
 * `Makefile`.
 *
 * # Step 3: Enrich the data
 *
 * The current `Makefile` inlines additional data for artworks from other
 * sources. How will this 'ingest'-based approach pull that data (ideally from
 * a separate ingest file?) and associate it with this object?
 *
 * For Mia artworks, there's all the info in `collection-links`. Should each of
 * those become it's own ingest in this tree?
 *
 * Step 4: Deploy the data
 *
 * The idea here is for all data processing to happen from one place. Currently
 * this repo handles redis => elasticsearch with some enrichment.
 * `artsmia/collection` tackles redis => github separately. Integrating these
 * would be ideal, and perhaps this should live in `artsmia/collection`?
 */
