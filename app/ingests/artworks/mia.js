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
const ndjson = require('ndjson')

// reads the data all at once
// how to pass the raw data on to the next step of the process?
// [1]
// Should this be a generator that's called somewhere else?
// Or a readable stream with each artwork as a chunk>?
// Or an event emitter that pings out each artwork?
//
// Does it even need to be async? The bottleneck isn't reading
// from redis, it's probably sending into ES
async function read(args = {}) {
  const allBuckets = (await redis.keys('object:*'))
    .map(bucketString => Number(bucketString.replace('object:', '')))
    .sort((a, b) => a - b)
  const buckets =
    args.buckets === 0 || args.buckets ? [args.buckets].flat() : allBuckets

  const stream = ndjson.stringify()

  buckets.map(async bucket => {
    // returns an object with all the artworks in this bucket
    //
    //     { id<String>: data<String>, … }
    const objectsRaw = await redis.hgetall(`object:${bucket}`)
    const objects = Object.values(objectsRaw)
      .map(o => {
        if (o.match && o.match('Error with id:')) return

        const apiErrorPattern = /^[\s\S]+{"id"/gm
        if (o.match(apiErrorPattern)) {
          o = o.replace(apiErrorPattern, '{"id"')
        }

        try {
          const json = JSON.parse(o)
          stream.write(json)
          return json
        } catch (e) {
          const entry = Object.entries(objectsRaw).find(entry => entry[1] === o)
          // id:121512 only has TMS/mssql errors in my local redis, no data at all.
          // The redis instance on collections has data -- must be a blip
          // that's been fixed in TMS? (The error mentions 'server shutdown',
          // so the API call must have been made when TMS was borked.
          console.error('error reading mia artwork data', { e, entry })
        }
      })
      .filter(o => o)
      .flat()

    // OK, now what to do with the artwork data?
    // see [1] above
    console.info(bucket, objects.length)
  })

  return stream
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

/**
 * # Step 2: Normalize the data
 *
 * There are some idiosyncracies in the Mia artwork API around character
 * encoding and artist name that need to be ironed out. See the numerous
 * replacements made with `sed` in the existing `streamRedis` command in
 * `Makefile`.
 */

function replaceMisEncodedCharacters(data) {
  const replacements = {
    o_: 'ō',
    u_: 'ū',
    '&amp;': '&',
  }

  Object.keys(data).map(key => {
    const newData =
      data[key] &&
      data[key].replace &&
      data[key].replace(
        new RegExp(Object.keys(replacements).join('|'), 'g'),
        match => replacements[match]
      )

    if (newData) data[key] = newData
  })

  return data
}

function transform(_data) {
  const data = replaceMisEncodedCharacters(_data)

  return {
    ...data,
    // Strip URL portion from ID, leaving just the number
    id: data.id.replace('http://api.artsmia.org/objects/', ''),
    // Only leave `see_also` in place when there's meaningful content
    see_also: data.see_also && data.see_also[0] !== '' ? data.see_also : null,
    provenance: data.provenance === '' ? null : data.provenance,
    // Portfolio has `From` for every record, and records with actual
    // `portfolio` data have "From From" at the beginning of the field
    portfolio:
      data.portfolio === 'From '
        ? null
        : data.portfolio.replace('From From', 'From'),
    // replace garbled copyright character
    image_copyright: data.image_copyright.replace(
      /%C2%A9|%26Acirc%3B%26copy%3B/,
      '©'
    ),
  }

  // Transform ideas:
  //
  // enable links in `text`? Link accession numbers?
  //     https://collections.artsmia.org/art/116117/protest-2-shomei-tomatsu
  //     ^ has "The two photographs [2013.22.1,2]"
  // or should this be an 'enrich' step? (What's the difference?)
}

/** Step 3: Enrich the data
 *
 * The current `Makefile` inlines additional data for artworks from other
 * sources. How will this 'ingest'-based approach pull that data (ideally from
 * a separate ingest file?) and associate it with this object?
 *
 * For Mia artworks, there's all the info in `collection-links`. Should each of
 * those become it's own ingest in this tree?
 *
 * Expound on `artist` and create entities in ES for each constituent named in
 * the raw text of this field. Cross-reference that with wikidata, and maybe
 * pull out a skeleton bio?
 */

/** Step 4: Deploy the data
 *
 * The idea here is for all data processing to happen from one place.
 *
 * Currently this repo's Makefile handles redis => elasticsearch with some
 * enrichment. `artsmia/collection` tackles redis => github separately.
 * Integrating these would be ideal, then expanding.
 */

/** ----------- */

module.exports = { read, stream, transform }
