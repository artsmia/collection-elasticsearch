/** @format
 */

var express = require('express'),
  app = express(),
  cors = require('cors'),
  cookieParser = require('cookie-parser')

app.use(cors())
app.use(cookieParser())

app.listen(process.env.PORT || 3000)

app.get('/', function(req, res) {
  res.end(
    [
      "you have found @artsmia's search API!",
      '`/:search` will return artworks in our collection matching the given search term. (add `?format=csv` to a search to recieve a CSV file with results)',
      '`/id/:id` returns artworks based on their "object ID".',
      '`/id/:ids` returns artworks based on a list of comma-separated "object ID"s.',
      '`/random/art` returns a random artwork.',
      '`/people/:id` returns the information we have on a person or entity related to our collection.',
    ].join('\n\n')
  )
})

const personEndpoint = require('./person')
const searchEndpoints = require('./search')
const surveyEndpointFactory = require('./survey')

app.get('/:query', searchEndpoints.search)
app.get('/id/:id', searchEndpoints.id)
app.get('/ids/:ids', searchEndpoints.ids)
app.get('/tag/:tag', searchEndpoints.tag)
app.get('/people/:id', personEndpoint)

// Broken because opensearch doesn't have the suggest() helper.
// app.get('/autofill/:prefix', searchEndpoints.autofill)

app.get('/random/art', searchEndpoints.random)

surveyEndpointFactory(app, express)
