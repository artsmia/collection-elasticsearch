/** @format */
const ndjson = require('ndjson')

const {
  read: readMia,
  stream: streamMia,
  transform: transformMia,
} = require('./artworks/mia')

// readMia({ buckets: [83] })
false &&
  readMia()
    // prettier-ignore
    .then(output => {
      // Is it useless to stringify the JSON to a stream just to immediately parse it again?
      output
        // .pipe(transform) // TODO learn streams
        .pipe(ndjson.parse())
        .on('data', function(obj) {
          const reshaped = transformMia(obj)
          if (reshaped.id === '1') console.info({ reshaped })
        })
    })

// stream()

const {
  read: readFitD,
  stream: streamFitD,
  transform: transformFitD,
} = require('./artworks/foot-in-the-door')

readFitD()

console.info('ingests/index done.')
