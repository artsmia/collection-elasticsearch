/** @format
 */

//
// Code to save artwork likes/dislikes to redis along with user session
//

var redis = require('redis')
var dataClient = redis.createClient(process.env.REDIS_PORT, process.env.REDIS_HOST)
dataClient.select(7)

/**
 * @param {Request} req
 * @param {Response} res
 */
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

/**
 * @param {Request} req
 * @param {Response} res
 */
function setCorsHeadersToAllowCookies(req, res) {
  console.info('setCorsHeadersToAllowCookies', req.headers.origin)
  res.header("Access-Control-Allow-Origin", req.headers.origin)
  res.header("Access-Control-Allow-Credentials", true)
}

/**
 * @param {string} likeOrDislike
 * @param {Request} req
 * @param {Response} res
 */
function rateArtwork(likeOrDislike, req, res) {
  getUserId(req, res, function(err, userId) {
    var artworkId = req.params.id
    dataClient.sadd(`survey:user:${userId}:${likeOrDislike}`, artworkId, redis.print)
    return res.send(`user ${userId} ${likeOrDislike} art ${artworkId}`)
  })
}

/**
 * @param {Request} req
 * @param {Response} res
 */
function getRated(req, res) {
  getUserId(req, res, function(err, userId) {
    dataClient.smembers(`survey:user:${userId}:likes`, function(err, likes) {
      return res.json({userId, likes})
    })
  })
}

/**
 * @param {Request} req
 * @param {Response} res
 */
function saveJSONData(req, res) {
  const {surveyId} = req.params || {}
  const {data} = req.query || {}
  const defaultSurveyId = 'collections-redesign'
  getUserId(req, res, function(err, userId) {
    const key = `survey:${surveyId || defaultSurveyId}:${userId}`

    console.info('saveJSONData', {surveyId, data, key})

    dataClient.set(key, data, function(err, status) {
      dataClient.get(key, function(err, data) {
        return res.json({
          userId,
          data: JSON.parse(data),
          status,
        })
      })
    })
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

  app.all('/survey/art/:id/like', function(req, res) {
    rateArtwork('likes', req, res)
  })
  app.all('/survey/art/:id/dislike', function(req, res) {
    rateArtwork('dislikes', req, res)
  })
  app.all('/survey/favorites', function(req, res) {
    getRated(req, res)
  })


  app.all('/survey/redesign', function(req, res) {
    saveJSONData(req, res)
  })
  app.all('/survey/:surveyId', function(req, res) {
    saveJSONData(req, res)
  })
  // app.get('/survey/:surveyId', function(req, res) {
  //   const {surveyId} = req.params
  //   getUserId(req, res, function(err, userId) {
  //     const key = `survey:${surveyId}:${userId}`
  //     dataClient.get(key, function(err, data) {
  //       return res.json({userId, data: JSON.parse(data)})
  //     })
  //   })
  // })

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

