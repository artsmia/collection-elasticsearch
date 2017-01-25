var es = new require('elasticsearch').Client({
  host: process.env.ES_URL,
  log: false,
  requestTimeout: 3000,
})

var search = function(query, size, sort, filters, isApp, from, req, callback) {
  var fields = ["artist.artist^15", "artist.folded^15", "title^11", "description^3", "text^2", "accession_number", "_all", "artist.ngram^2", "title.ngram"]
  if(query.match(/".*"/)) fields = fields.slice(0, -2)
  if(filters) query += ' '+filters
  var limitToPublicAccess = req.query.token != process.env.PRIVATE_ACCESS_TOKEN
  if(limitToPublicAccess && [query, filters].indexOf('deaccessioned:true') + [query, filters].indexOf('deaccessioned:"true"') === -2) query += ' public_access:1'
  if(isApp) query += ' room:G*'

  var searches = {
    flt: {
      fields: fields,
      like_text: query,
    },
    multi_match: {
      query: query,
      fields: fields,
      type: "best_fields",
      tie_breaker: 0.3,
    },
    common: {
      _all: {
        query: query,
        cutoff_frequency: 0.01,
        minimum_should_match: { low_freq: 1, high_freq: 3 }
      },
    },
    sqs: {
      query: query,
      fields: fields,
      tie_breaker: 0.3,
      default_operator: "and",
      // default_operator: "or",
      minimum_should_match: "2<60%",
      // "fuzzy_prefix_length" : 3,
    },
  }

  var function_score_sqs = {
    query: {query_string: searches.sqs}, // good
    //query: {flt: searches.flt}, // not great
    //query: {multi_match: searches.multi_match}, // good
    //query: {common: searches.common}, // ok, v different from sqs and multi
    functions: [
      {filter: {term: {highlight: "true"}}, weight: 3},
      {filter: {term: {featured: "true"}}, weight: 2.5},
      {filter: {term: {image: "valid"}}, weight: 2},
      {filter: {prefix: {room: "g"}}, weight: 1.1},
      // {filter: {prefix: {room: "g"}}, weight: isApp ? 1.1 : 101},
    ],
    score_mode: "sum"
  }

  var q = {function_score: function_score_sqs}
  var suggest = {
    text: query,
    artist: {
      term: {
        field: "artist",
      }
    },
    "artist_completion" : {
      "completion": {
        "field" : "artist_suggest"
      }
    },
    "title_completion" : {
      "completion": {
        "field" : "title_suggest"
      }
    }
  }
  var aggSize = 200
  var aggs = {
    "Image": {"terms": {"script": "doc['image'].value == 'valid' ? 'Available' : 'Unavailable'", "size": aggSize}},
    // "Image": {"terms": {"field": "image", "size": aggSize}},
    // "Image": {
    // 	"terms": {
    // 		"field": "image",
    // 		"size": aggSize
    // 	},
    // 	"aggs": {
    // 		"image_rights_type": {"terms": {"field": "image_rights_type"}},
    // 	}
    // },
    "On View": {"terms": {"script": "doc['room.raw'].value == 'Not on View' ? 'Not on View' : 'On View'", size: aggSize}},
    // "On View": {
    //   "terms": {
    //     "script": "doc['room.raw'].value == 'Not on View' ? 'Not on View' : 'On View'",
    //     size: aggSize
    //   },
    //   "aggs": {"Room": {"terms": {"field": "room.raw", "size": aggSize}}},
    // },
    "Room": {"terms": {"field": "room.raw", "size": aggSize}},
    "Rights": {"terms": {"field": "rights"}},
    "Artist": {"terms": {"field": "artist.raw", "size": aggSize}},
    "Country": {"terms": {"field": "country.raw", "size": aggSize}},
    "Style": {"terms": {"field": "style.raw", "size": aggSize}},
    "Medium": {"terms": {"field": "medium.stop", "size": aggSize}},
    "Classification": {"terms": {"field": "classification", "size": aggSize}},
    "Title": {"terms": {"field": "title.raw", "size": aggSize}},
    "Gist": {"significant_terms": {"field": "_all"}},
    "Department": {"terms": {"field": "department.raw", "size": aggSize}},
    "Tags": {"terms": {"field": "tags", "size": aggSize}},
    // "image_rights_type": {"terms": {"field": "image_rights_type"}},
    // other facets? department
    // "year": {"histogram": {"field": "dated", "interval": 50}},
    // "year": {"terms": {"field": "dated", "size": aggSize}},
    // "Creditline": {"terms": {"field": "creditline.raw", "size": aggSize}},
  }
  var highlight = {fields: {"*": {fragment_size: 5000, number_of_fragments: 1}}}

  var search = {
    index: process.env.ES_index,
    body: {
      query: q,
      aggs: aggs,
      highlight: highlight,
      suggest: suggest,
    },
    size: size,
    from: from,
    limitToPublicAccess: limitToPublicAccess,
  }
  // when the search is undefined or blank, do a count over the aggregations
  if(query == '' || query == undefined) {
    search = {body: {size: 0, aggs: aggs}, searchType: 'count'}
  }

  if(sort) {
    var [sortField, sortOrder] = sort.split('-')
    search.body.sort = {[sortField]: {order: sortOrder || 'asc'}}
  }

  checkRedisForCachedSearch(search, query, req, function(err, cachedResult, cacheKey) {
    // if this has been cached in redis, return that result directly
    if(cachedResult) {
      return callback(null, cachedResult)
    }

    es.search(search).then(function (body) {
      body.query = q
      callback(null, body)

      if(!req.query.expireCache) {
        var cacheTTL = body.took*60
        body.cache = {cached: true, key: cacheKey}
        client.set(cacheKey, JSON.stringify(body), function(err, reply) {
          if(!err) client.expire(cacheKey, cacheTTL)
        })
      }
    }, function (error) {
      console.error(error)
      callback(error, [])
    })
  })
}

var redis = require('redis')
  , client = redis.createClient()
  , express = require('express')
  , app = express()
  , cors = require('cors')

app.use(cors())

app.get('/', function(req, res) {
  res.end('.')
})

app.get('/:query', function(req, res) {
  if(req.params.query == 'favicon.ico') return res.send(404)
  var replies = []
  var size = req.query.size || 100
  var sort = req.query.sort
  var from = req.query.from || 0
  var filters = req.query.filters
  var userAgent = req.headers['user-agent']
  var isApp = userAgent && userAgent.match('MIA') // 'MIA/8 CFNetwork/758.0.2 Darwin/15.0.0' means this request came frmo the journeys app
  search(req.params.query || '', size, sort, filters, isApp, from, req, function(error, results) {
    results.query = req.params.query
    results.filters = filters
    results.error = error
    return res.send(results, error && error.status || 200)
  })
})

app.get('/id/:id', function(req, res) {
  var id = req.params.id
  if(id == 'G320') return res.json(prindleRoom)
  es.get({id: id, type: 'object_data', index: process.env.ES_index}, function(err, reply) {
    if(err) {
      console.error('ES error', err)
      return client.hget('object:'+~~(id/1000), id, function(err, reply) {
        return res.json(JSON.parse(reply))
      })
    }
    res.json(reply._source)
  })
})

app.get('/ids/:ids', function(req, res) {
  var ids = req.params.ids.split(',')
  var docs = ids.map(function(id) {
    return {_index: process.env.ES_index, _type: 'object_data', _id: id}
  })

  es.mget({body: {docs: docs}}, function (err, response) {
    if (err) {
      console.error(err)
      return res.send('oops')
    }

    res.json({
      hits: {
        total: response.docs.length,
        hits: response.docs
      }
    })
  })
})

app.get('/tag/:tag', function(req, res) {
  client.smembers('tag:'+req.params.tag, function(err, ids) {

    var m = client.multi()
    ids.forEach(function(id) { m.hget('object:'+~~(id/1000), id) })

    m.exec(function(err, replies) {
      var filter = req.query.filter
      if(filter == undefined) return res.json(replies.map(function(meta) { return JSON.parse(meta) }))
      filter = filter.split(',')
      var filtered = replies.map(function(meta) {
        if(meta == null) return
        var json = JSON.parse(meta)
        return filter.reduce(function(all, field) {
          all[field] = json[field]; return all
        }, {})
      })
      return res.send(filtered)
    })
  })
})

// var http = require('http')
// app.get('/artists.json', function(req, res) {
//   http.get(process.env.ES_URL+'/test/_search?search_type=count&pretty=true'node -d '{"aggs": {"artist": {"terms": {"field": "artist.raw", "size": 25000, "order": { "_term": "asc" }}}}}'

app.listen(process.env.PORT || 4680)

var prindleRoom = {
  accession_number: "82.43.1-60",
  artist: "John Scott Bradstreet",
  creditline: "Gift of funds from Wheaton Wood, by exchange",
  culture: "American",
  country: "United States",
  dated: "1906",
  life_date: "American, 1865-1914",
  title: 'Duluth Living Room (from the William and Mina Prindle House',
  room: "G320",
}

app.get('/autofill/:prefix', function(req, res) {
  var query = {
    index: process.env.ES_index,
    body: {
      "text": req.params.prefix,
      "artist_completion" : {
        "completion": {
          "field" : "artist_suggest"
        }
      },
      "highlight_artist_completion" : {
        "completion": {
          "field" : "highlight_artist_suggest"
        }
      },
      "title_completion" : {
        "completion": {
          "field" : "title_suggest"
        }
      }
    }
  }

  es.suggest(query).then(function (body) {
    res.json('autofill', body)
  })
})

app.get('/random/art', function(req, res) {
  var size = req.query.size || 1
  es.search({
    index: process.env.ES_index,
    body: {
      "query": {
        "function_score" : {
          "query" : { "match_all": {} },
          "random_score" : {}
        }
      }
    },
    size: size
  }).then(function(results, error) {
    var firstHitSource = results.hits.hits[0]._source
    return res.json(size == 1 ? firstHitSource : results.hits.hits, error && error.status || 200)
  })
})

// cache frequent searches, time-limited
function checkRedisForCachedSearch(search, query, req, callback) {
  var sortKey = 'sort:'+req.query.sort.replace('-asc', '')
  var cacheKey = 'cache::search::' + [query, search.size, search.from, sortKey].join("::").replace(/ /g, '-')
  if(!search.limitToPublicAccess) cacheKey = cacheKey + '::private'

  client.get(cacheKey, function(err, reply) {
    if(!!req.query.expireCache && reply) {
      client.del(cacheKey, redis.print)

      reply = JSON.parse(reply)
      reply.cache.expiring = true
      reply = JSON.stringify(reply)
    }

    return callback(err, reply, cacheKey)
  })
}

