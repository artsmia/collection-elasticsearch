var spellchecker = require('spellchecker')

var es = new require('elasticsearch').Client({
  host: process.env.ES_URL+'/'+process.env.ES_index,
  log: false
})

var search = function(query, size, filters, callback) {

var fields = ["artist.artist^15", "artist.folded^15", "title^11", "description^3", "text^2", "accession_number", "_all", "artist.ngram^2", "title.ngram"]
if(filters) query += ' '+filters
if([query, filters].indexOf('deaccessioned:true') + [query, filters].indexOf('deaccessioned:"true"') === -2) query += ' public_access:1'
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
    {filter: {term: {image: "valid"}}, weight: 2},
    {filter: {prefix: {room: "g"}}, weight: 1.1},
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
    // "Image": {"terms": {"script": "doc['image'].value == 'valid' ? 'yes' : 'no'", "size": aggSize}},
    "Image": {"terms": {"field": "image", "size": aggSize}},
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
    "Medium": {"terms": {"field": "medium", "size": aggSize}},
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
  var highlight = {fields: {"*": {fragment_size: 500, number_of_fragments: 5}}}

  var search = {body: {query: q, aggs: aggs, highlight: highlight, suggest: suggest}, size: size}
  // when the search is undefined or blank, do a count over the aggregations
  if(query == '' || query == undefined) {
    search = {body: {size: 0, aggs: aggs}, searchType: 'count'}
  }
  es.search(search).then(function (body) {
    body.query = q
    var spellings = spellchecker.getCorrectionsForMisspelling(query)
    body.spellcheck = spellings
    callback(null, body)
  }, function (error) {
    console.log(error)
    callback(error, [])
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
  var filters = req.query.filters
  search(req.params.query || '', size, filters, function(error, results) {
    results.query = req.params.query
    results.filters = filters
    results.error = error
    return res.send(results, error && error.status || 200)
  })
})

app.get('/id/:id', function(req, res) {
  var id = req.params.id
  if(id == 'G320') return res.json(prindleRoom)
  client.hget('object:'+~~(id/1000), id, function(err, reply) {
    res.json(JSON.parse(reply))
  })
})

app.get('/ids/:ids', function(req, res) {
  var ids = req.params.ids.split(',')
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

app.get('/tag/:tag', function(req, res) {
  client.smembers('tag:'+req.params.tag, function(err, ids) {
    console.info('tag', req.params, ids.length)

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

app.listen(4680)

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
