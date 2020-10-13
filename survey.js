/** @format
 */

//
// Code to save artwork likes/dislikes to redis along with user session
//

var redis = require('redis')
var dataClient = redis.createClient()
dataClient.select(7)

function getUserId(req, res, callback) {
  const cookieName = 'artsmiaUserId'
  setCorsHeadersToAllowCookies(req, res)

  // If there is a userId set in the 
  // cookies already, use that and we're done.
  var existingId = req && req.cookies && req.cookies[cookieName]
  if(existingId) return callback(null, existingId, existingId)

  // If not, obtain the next available id (`newId`) from redis,
  // send it back to the calling function,
  // and also append it to `res` so it goes back to the requesting browser
  dataClient.get('nextUserId', function(err, newId, existingId) {
    res.cookie(cookieName, newId, {sameSite: 'None', secure: true})
    dataClient.incrby('nextUserId', 1)
    return callback(null, newId)
  })
}

function setCorsHeadersToAllowCookies(req, res) {
  console.info('setCorsHeadersToAllowCookies', req.headers.origin)
  res.header("Access-Control-Allow-Origin", req.headers.origin)
  res.header("Access-Control-Allow-Credentials", true)
}

function rateArtwork(likeOrDislike, req, res) {
  getUserId(req, res, function(err, userId) {
    var artworkId = req.params.id
    dataClient.sadd(`survey:user:${userId}:${likeOrDislike}`, artworkId, redis.print)
    return res.send(`user ${userId} ${likeOrDislike} art ${artworkId}`)
  })
}

function saveJSONData(req, res) {
  const {data} = req.query || {}
  setCorsHeadersToAllowCookies(req, res)
  getUserId(req, res, function(err, userId) {
    const key = `survey:collections-redesign:${userId}`

    dataClient.set(key, data, redis.print)
    return res.send(`saved data for user ${userId}.`)
  })
}

// because this needs access to express, try building the routes as a function
// that's called from `index.js`
module.exports = function(app, express) {
  // app.use(express.cookieParser(process.env.SECRET_COOKIE_TOKEN))
  // app.use(express.cookieSession())
  // app is already set up with cookie-parser in index.js?

  app.all('/survey/getUser', function(req, res) {
    getUserId(req, res, function(err, userId) {
      return res.json(userId)
    })
  })

  app.all('/survey/getUserData', function(req, res) {
    getUserId(req, res, function(err, userId) {
      const key = `survey:collections-redesign:${userId}`
      dataClient.get(key, function(err, data) {
        return res.json({userId, data: JSON.parse(data)})
      })
    })
  })

  app.all('/survey/art/:id/like', function(req, res) {
    rateArtwork('likes', req, res)
  })

  app.all('/survey/art/:id/dislike', function(req, res) {
    rateArtwork('dislikes', req, res)
  })

  app.all('/survey/redesign', function(req, res) {
    saveJSONData(req, res)
  })

  app.get('/survey/data', function(req, res) {
    var multi = dataClient.multi()

    dataClient.keys('survey:user*', function(err, keys) {
      var _keys = keys.map(key => ['smembers', key])
      dataClient.multi(_keys).exec(function(err, replies) {
        var keysAndValues = keys
        .sort((key1, key2) => parseInt(key1.split(':')[2]) - parseInt(key2.split(':')[2]))
        .reduce((map, key, index) => {
          map[key] = replies[index]
          return map
        }, {})

        return res.json(keysAndValues)
      })
    })
  })
}

