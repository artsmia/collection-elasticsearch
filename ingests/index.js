const {read, stream} = require('./artworks/mia')

read()
// read({buckets: [0, 1, 2, 3, 4, 5]})

// stream()

console.info('ingests/index done.')
