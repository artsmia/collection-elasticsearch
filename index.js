var es = new require('elasticsearch').Client({
  host: process.env.ES_URL,
  log: false,
  requestTimeout: 3000,
})

var redis = require('redis')
  , client = redis.createClient()
  , express = require('express')
  , app = express()
  , cors = require('cors')

app.use(cors())

app.get('/', function(req, res) {
  res.end([
    'you have found @artsmia\'s search API!',
    '`/:search` will return artworks in our collection matching the given search term. (add `?format=csv` to a search to recieve a CSV file with results)',
    '`/id/:id` returns artworks based on their "object ID".',
    '`/people/:id` returns the information we have on a person or entity related to our collection.'
  ].join('\n\n'))
})

// var http = require('http')
// app.get('/artists.json', function(req, res) {
//   http.get(process.env.ES_URL+'/test/_search?search_type=count&pretty=true'node -d '{"aggs": {"artist": {"terms": {"field": "artist.raw", "size": 25000, "order": { "_term": "asc" }}}}}'

app.listen(process.env.PORT || 4680)

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
    res.json(body)
  })
})

app.get('/random/art', function(req, res) {
  var size = req.query.size || 1
  var query = req.query && req.query.q ?
    { "query_string": {query: req.query.q += ' public_access:1'}} :
    { "query_string": {query: 'public_access:1'} }

  es.search({
    index: process.env.ES_index,
    body: {
      "query": {
        "function_score" : {
          "query" : query,
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

const personEndpoint = require('./person')
const searchEndpoints = require('./search')

app.get('/:query', searchEndpoints.search)
app.get('/id/:id', searchEndpoints.id)
app.get('/ids/:ids', searchEndpoints.ids)
app.get('/tag/:tag', searchEndpoints.tag)
app.get('/people/:id', personEndpoint)

const surveyFactory = require('./survey')
surveyFactory(app, express)
