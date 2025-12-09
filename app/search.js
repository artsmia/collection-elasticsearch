/** @format
 */

const buildRedisClient = require('./lib/buildRedisClient');
const es = require('./lib/esClient');
const Json2csvParser = require('json2csv').Parser

const client = buildRedisClient();
client.connect();

const CACHE_SEARCHES = false;

var prindleRoom = {
  accession_number: '82.43.1-60',
  artist: 'John Scott Bradstreet',
  creditline: 'Gift of funds from Wheaton Wood, by exchange',
  culture: 'American',
  country: 'United States',
  dated: '1906',
  life_date: 'American, 1865-1914',
  title: 'Duluth Living Room (from the William and Mina Prindle House',
  room: 'G320',
}

var search = function(query, size, sort, filters, isApp, dataPrefix, from, req, callback) {
  var fields = [
    'artist^15',
    'title^11',
    'description^3',
    'text^2',
    'accession_number',
    '_all',
    'artist.ngram^2',
    'title.ngram',
  ]

  if (query.match(/".*"/)) {
    fields = fields.slice(0, -2)
  }

  if (filters) {
    query += ' ' + filters
  }

  let limitToPublicAccess = !process.env.PRIVATE_ACCESS_TOKEN ||
    (req.query.token !== process.env.PRIVATE_ACCESS_TOKEN)
  if (query.includes('deaccessioned:true') || query.includes('deaccessioned:"true"')) {
    limitToPublicAccess = false;
  }
  if (limitToPublicAccess) {
    query += ' public_access:1'
  }

  // if(isApp) query += ' room:G*' // restrict searches from the journeys app to only on view objects
  var isMoreArtsmia =
    (req.headers.origin && req.headers.origin.match('//more.artsmia.org')) ||
    (req.query.tag && req.query.tag === 'more')
  var boostOnViewArtworks = isApp || isMoreArtsmia

  var searches = {
    flt: {
      fields: fields,
      like_text: query,
    },
    multi_match: {
      query: query,
      fields: fields,
      type: 'best_fields',
      tie_breaker: 0.3,
    },
    common: {
      _all: {
        query: query,
        cutoff_frequency: 0.01,
        minimum_should_match: { low_freq: 1, high_freq: 3 },
      },
    },
    sqs: {
      query: query,
      fields: fields,
      tie_breaker: 0.3,
      default_operator: 'and',
      // default_operator: "or",
      minimum_should_match: '2<60%',
      // "fuzzy_prefix_length" : 3,
    },
  }

  var function_score_sqs = {
    query: { query_string: searches.sqs }, // good
    //query: {flt: searches.flt}, // not great
    //query: {multi_match: searches.multi_match}, // good
    //query: {common: searches.common}, // ok, v different from sqs and multi
    functions: [
      { filter: { term: { highlight: 'true' } }, weight: 3 },
      { filter: { term: { featured: 'true' } }, weight: 2.5 },
      { filter: { term: { image: 'valid' } }, weight: 2 },
      {
        filter: { prefix: { room: 'g' } },
        weight: boostOnViewArtworks ? 101 : 1.1,
      },
      {
        filter: { exists: { field: 'related:artstories' } },
        weight: isMoreArtsmia ? 50 : 1.1,
      },
      {
        filter: { exists: { field: 'related:newsflashes' } },
        weight: isMoreArtsmia ? 50 : 1.1,
      },
      {
        filter: { exists: { field: 'related:audio-stops' } },
        weight: isMoreArtsmia ? 50 : 1.1,
      },
      {
        filter: { exists: { field: 'related:3dmodels' } },
        weight: isMoreArtsmia ? 50 : 1.1,
      },
      {
        filter: { exists: { field: 'related:stories' } },
        weight: isMoreArtsmia ? 50 : 1.1,
      },
    ],
    score_mode: 'sum',
  }

  var q = { function_score: function_score_sqs }
  var suggest = {
    text: query,
    artist: {
      term: {
        field: 'artist',
      },
    },
    artist_completion: {
      completion: {
        field: 'artist_suggest',
      },
    },
    title_completion: {
      completion: {
        field: 'title_suggest',
      },
    },
  }
  var aggSize = 200
  var aggs = {
    // Note: Several entries have been deleted because they fail to execute
    // under OpenSearch, or due to flaws in the mappings/data migration process.
    Room: { terms: { field: 'room.raw', size: aggSize } },
    Rights: { terms: { field: 'rights_type.keyword' } },
    Artist: { terms: { field: 'artist.raw', size: aggSize } },
    Country: { terms: { field: 'country.raw', size: aggSize } },
    Style: { terms: { field: 'style.raw', size: aggSize } },
    Medium: { terms: { field: 'medium.stop', size: aggSize } },
    Classification: { terms: { field: 'classification.keyword', size: aggSize } },
    Title: { terms: { field: 'title.raw', size: aggSize } },
    Gist: { significant_terms: { field: '_all' } },
    Department: { terms: { field: 'department.raw', size: aggSize } },
    Tags: { terms: { field: 'tags', size: aggSize } },
  }
  var highlight = {
    fields: { '*': { fragment_size: 5000, number_of_fragments: 1 } },
  }

  var [type,index] = getTypeIndexFromDataPrefix(dataPrefix)

  var search = {
    index: index,
    body: {
      query: q,
      aggs: aggs,
      highlight: highlight,
      // suggest: suggest,
    },
    size: size,
    from: from,
  }
  if (dataPrefix) {
    search.dataPrefix = dataPrefix;
  }
  if (isMoreArtsmia) {
    search.isMoreArtsmia = isMoreArtsmia;
  }
  if (boostOnViewArtworks) {
    search.boostOnViewArtworks = boostOnViewArtworks;
  }

  // when the search is undefined or blank, do a count over the aggregations
  if (!query) {
    search = { body: { size: 0, aggs: aggs }, searchType: 'count' }
  }

  if (sort) {
    var [sortField, sortOrder] = sort.split('-')
    search.body.sort = { [sortField]: { order: sortOrder || 'asc' } }
  }

  checkRedisForCachedSearch(search, query, req, function(
    err,
    cachedResult,
    cacheKey
  ) {
    // if this has been cached in redis, return that result directly
    if (cachedResult) {
      return callback(null, JSON.parse(cachedResult))
    }

    es.search(search).then(
      function({ body }) {
        body.query = q
        callback(null, body)

        var skipCaching = !CACHE_SEARCHES ||
          req.query.expireCache ||
          req.query.tag

        if (!skipCaching) {
          var cacheTTL = body.took * 60
          body.cache = { cached: true, key: cacheKey }
          client.set(cacheKey, JSON.stringify(body))
            .then(() => client.expire(cacheKey, cacheTTL))
            .catch(err => console.error(err));
        }
      },
      function(error) {
        console.error(error)
        callback(error, [])
      }
    )
  })
}

/**
 * @param {Request} req
 * @param {Response} res
 */
var searchEndpoint = function(req, res) {
  var query = String(req.params.query || '');
  if (query === 'favicon.ico') {
    return res.sendStatus(400);
  }
  var size = Number(req.query.size || (req.query.format === 'csv' ? 1000 : 100))
  var sort = String(req.query.sort || '')
  var from = Number(req.query.from || 0)
  var filters = String(req.query.filters || '')
  var userAgent = String(req.headers['user-agent'] || '')
  var isApp = userAgent.match('MIA') // 'MIA/8 CFNetwork/758.0.2 Darwin/15.0.0' means this request came frmo the journeys app
  var dataPrefix = String(req.query.dataPrefix || '') // pull data from a non-mia-artworks index

  search(
    query,
    size,
    sort,
    filters,
    isApp,
    dataPrefix,
    from,
    req,
    function(error, results) {
      results.query = query
      results.filters = filters
      results.error = error

      if (req.query.format !== 'csv') {
        return res.status(error ? (error.status || 500) : 200).json(results)
      }

      // How to re-query and pull the full set of results, or at least up to a higher limit?
      if (typeof results === 'string') {
        // re-parse cached JSON string
        results = JSON.parse(results)
      }

      const hits = results.hits.hits.map(
        hit => Object.assign(hit._source, {
          searchTerm: query,
          searchScore: hit._score,
        })
      )

      const csv = new Json2csvParser({}).parse(hits)

      const filename = `minneapolis institute of art search: ${
        query
      }.csv`

      res.attachment(filename)
      res.send(csv)
      // TODO - "download as CSV" button on collections search pages
    }
  )
}

const baseUrl =
  process.env.NODE_ENV === 'production'
    ? `https://search.artsmia.org`
    : 'http://localhost:3000'

function getTypeIndexFromDataPrefix(prefix) {
  if(prefix === 'fitd') return ['foot-in-the-door', 'foot-in-the-door']
  if(prefix === 'ca21') return ['creativity-academy-2021', 'creativity-academy-2021']
  if(prefix === 'aib21') return ['art-in-bloom-2021', 'art-in-bloom-2021']
  return [undefined, process.env.OS_INDEX]
}

/**
 * @param {Request} req
 * @param {Response} res
 */
var id = function(req, res) {
  var id = req.params.id
  if (id === 'G320') {
    return res.json(prindleRoom)
  }

  // if the given :id isn't numeric, do an "I'm feeling lucky" search
  if (!id.match(/\d+/)) {
    const toFirstHit = function(error, results) {
      if (typeof results === 'string') results = JSON.parse(results)

      if (results.hits.total === 0) error = 'No results found'
      if (error) return res.status(404).json({ error: error })

      const firstId = results.hits.hits[0]._id
      return res.redirect(`${baseUrl}/id/${firstId}`)
    }

    return search(id, 1, undefined, undefined, false, dataPrefix, 0, req, toFirstHit)
  }

  var dataPrefix = req.query.dataPrefix
  var [type, index] = getTypeIndexFromDataPrefix(dataPrefix)

  es.get({ id: id, type: type, index: index })
    .then(reply => {
      res.json(reply.body._source);
    })
    .catch(err => {
      console.error('ES error', err)
      return client.hGet('object:' + ~~(id / 1000), id)
        .then(reply => res.json(JSON.parse(reply)));
    })
}

/**
 * @param {Request} req
 * @param {Response} res
 */
var ids = function(req, res) {
  var ids = req.params.ids.split(',')
  var dataPrefix = req.query.dataPrefix
  var [type, index] = getTypeIndexFromDataPrefix(dataPrefix)
  var docs = ids.map(function(id) {
    return { _index: index, _type: type, _id: id }
  })

  es.mget({ body: { docs: docs } })
    .then(response => {
      if (req.query.format !== 'csv') {
        return res.json({
          hits: {
            total: response.body.docs.length,
            hits: response.body.docs,
          },
        });
      }

      const hits = response.body.docs.map(hit => {
        return Object.assign(hit._source, {
          searchTerm: req.params.query,
          searchScore: hit._score,
        });
      });

      const csv = new Json2csvParser({}).parse(hits);

      const filename = `minneapolis institute of art search: ${
        ids.join('-')
      }.csv`;

      res.attachment(filename);
      res.send(csv);
    })
    .catch(err => {
      console.error(err);
      return res.send('oops');
    });
}

/**
 * @param {Request} req
 * @param {Response} res
 */
var tag = function(req, res) {
  // TODO rewrite to use OpenSearch...somehow.
  client.sMembers('tag:' + req.params.tag)
    .then(ids => {
      var m = client.multi()
      ids.forEach(function(id) {
        m.hGet('object:' + ~~(id / 1000), id)
      })

      m.exec()
        .then(replies => {
          var filter = req.query.filter
          if (filter == undefined)
            return res.json(
              replies.map(function(meta) {
                return JSON.parse(meta)
              })
            )
          filter = filter.split(',')
          var filtered = replies.map(function(meta) {
            if (meta == null) return
            var json = JSON.parse(meta)
            return filter.reduce(function(all, field) {
              all[field] = json[field]
              return all
            }, {})
          })
          return res.send(filtered)
        });
    });
}

// cache frequent searches, time-limited
function checkRedisForCachedSearch(search, query, req, callback) {
  if (!CACHE_SEARCHES) {
    callback(null);
    return;
  }

  const cacheParams = new URLSearchParams();
  cacheParams.set('query', query);
  cacheParams.set('sort', String(req.query.sort || '').replace('-asc', ''));
  ['size', 'from', 'isMoreArtsmia', 'dataPrefix', 'limitToPublicAccess']
    .map(key => [key, search[key]])
    .filter(([k,v]) => Boolean(v))
    .forEach(([k,v]) => cacheParams.set(`search.${k}`, v))

  const cacheKey = `search.artsmia.org:${cacheParams.toString()}`

  client.get(cacheKey)
    .then(reply => {
      if (!!req.query.expireCache && reply) {
        client.del(cacheKey, redis.print)

        reply = JSON.parse(reply)
        reply.cache.expiring = true
        // reply = JSON.stringify(reply)
      }

      return callback(null, reply, cacheKey)
    })
    .catch(err => callback(err, null, cacheKey));
}

/**
 * /autofill/:prefix
 *
 * @param {Request} req
 * @param {Response} res
 */
var autofill = function(req, res) {
  throw new Error('disabled');
  /**
   * This is disabled because the ElasticSearch completion field mappings failed
   * to re-import into OpenSearch. The following code should work _if_ the
   * completion fields are created for artist_suggest, et al. and they are populated
   * in the data.
   */

  es.search({
    index: process.env.OS_INDEX,
    body: {
      suggest: {
        artist_completion: {
          prefix: req.params.prefix,
          completion: {
            field: 'artist_suggest',
          },
        },
        highlight_artist_completion: {
          prefix: req.params.prefix,
          completion: {
            field: 'highlight_artist_suggest',
          },
        },
        title_completion: {
          prefix: req.params.prefix,
          completion: {
            field: 'title_suggest',
          },
        }
      },
    },
  }).then(response => {
    res.json(response.body);
  }).catch(err => {
    console.error(err);
    return res.send('oops');
  });
}

/**
 * @param {Request} req
 * @param {Response} res
 */
var random = function(req, res) {
  var size = req.query.size || 1
  var query =
    req.query && req.query.q
      ? { query_string: { query: (req.query.q += ' public_access:1') } }
      : { query_string: { query: 'public_access:1' } }
  var dataPrefix = req.query.dataPrefix
  var [, index] = getTypeIndexFromDataPrefix(dataPrefix)

  es.search({
    index: index,
    body: {
      query: {
        function_score: {
          query: query,
          random_score: {},
        },
      },
    },
    size: size,
  }).then(function(results, error) {
    var firstHitSource = results.body.hits.hits[0]._source;
    res.status(error ? error.status: 200);
    return res.json(
      size === 1 ? firstHitSource : results.body.hits.hits
    )
  }).catch(error => {
    console.log(error);
    return res.json({ error: true });
  })
}

module.exports = {
  search: searchEndpoint,
  id: id,
  ids: ids,
  tag: tag,
  autofill: autofill,
  random: random,
}
