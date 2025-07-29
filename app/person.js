/** @format
 */

/* TODO:
 * pull more info from wikidata?
 *   "notable works" would be cool
 * accept a string param on /people that searches for a match by name
 *   then build an "artist decorator" on the collections site that links to profiles
 * don't load person data from janky files
 *   put the data from the janky files in redis and load from there?
 *   TMS/the API doesn't have access to consituent data so this is running off a side-loaded export file
 *   and mixNMatch is difficult to update
 */

const fs = require('fs')
const fetch = require('node-fetch')
const client = require('./lib/buildRedisClient')();

function getArtistData() {
  const fallbackDataDir = `${__dirname}/data-snapshot20250710`;

// Fall back to snapshot
  let dataDir = `${__dirname}/data`;
  if (!fs.existsSync(dataDir)) {
    console.warn(`${dataDir} missing, using ${fallbackDataDir}`);
    dataDir = fallbackDataDir;
  }

  let artists = JSON.parse(fs.readFileSync(`${dataDir}/artists-2019-02-04.json`))
  let artistsMixNMatch = JSON.parse(
    fs.readFileSync(`${dataDir}/artistsMixNMatch.json`)
  )

  return { artists, artistsMixNMatch };
}

const cachedFetch = url => {
  const cacheKey = `cache::wiki::${url}`

  return new Promise((resolve, reject) => {
    client.get(cacheKey, function(err, reply) {
      if (reply) return resolve(JSON.parse(reply))

      fetch(url).then(res => {
        res.json().then(json => {
          client.set(cacheKey, JSON.stringify(json), function(err, reply) {
            // TODO: set a decaying expiry? For now expire caches manually
            // if(!err) client.expire(cacheKey, cacheTTL)
          })
          resolve(json)
        })
      })
    })
  })
}

let wikiArticle = function(pageOrName) {
  let wikiExtractURL = `https://en.wikipedia.org/api/rest_v1/page/summary/${pageOrName}`
  return cachedFetch(wikiExtractURL)
}

let wikidata = function(artist) {
  const miaId = artist.id
  let wikidataQuery = `https://query.wikidata.org/sparql?query=PREFIX%20schema%3A%20%3Chttp%3A%2F%2Fschema.org%2F%3E%0A%0ASELECT%20%3Fartist%20%3FartistLabel%20%3FartistDescription%20%3Fimage%20%3Farticle%20%3FaicID%20%3FmomaID%20%3FsaamID%20WHERE%20%7B%0A%20%20%3Fartist%20wdt%3AP3603%20%22${miaId}%22.%0A%20%20OPTIONAL%20%7B%20%3Fartist%20wdt%3AP18%20%3Fimage.%20%7D%0A%20%20OPTIONAL%20%7B%0A%20%20%20%20%3Farticle%20schema%3Aabout%20%3Fartist.%0A%20%20%20%20%3Farticle%20schema%3AinLanguage%20%3Flang.%0A%20%20%20%20%3Farticle%20schema%3Aname%20%3Fname.%0A%20%20%20%20FILTER(%3Flang%20IN(%22en%22))%0A%20%20%20%20FILTER(CONTAINS(STR(%3Farticle)%2C%20%22wikipedia%22))%0A%20%20%7D%0A%20%20SERVICE%20wikibase%3Alabel%20%7B%20bd%3AserviceParam%20wikibase%3Alanguage%20%22en%2Cen%22.%20%7D%0A%20%20OPTIONAL%20%7B%20%3Fartist%20wdt%3AP6295%20%3FaicID.%20%7D%0A%20%20OPTIONAL%20%7B%20%3Fartist%20wdt%3AP2174%20%3FmomaID.%20%7D%0A%20%20OPTIONAL%20%7B%20%3Fartist%20wdt%3AP1795%20%3FsaamID.%20%7D%0A%7D&format=json`
  // If we have a Q value in TMS use it directly in the SPARQL query
  // the artist might not be linked to P3603 on wikidata, and if we have a
  // Q that's better anyway
  if (artist.q)
    wikidataQuery = wikidataQuery.replace(
      `%3Fartist%20wdt%3AP3603%20%22${miaId}%22.`,
      `BIND(wd:${artist.q}%20as%20?artist)`
    )
  return cachedFetch(wikidataQuery).then(json => {
    const bindings = json.results.bindings
    const values =
      bindings.length > 0
        ? Object.keys(bindings[0]).reduce((data, key) => {
            data[key] = bindings[0][key].value
            return data
          }, {})
        : {}

    return values
  })
}

/**
 * @param {Request} req
 * @param {Response} res
 */
module.exports = function(req, res) {
  const id = req.params.id;

  const { artists, artistsMixNMatch } = getArtistData();

  const matchingArtist = artists.find(artist => {
    return (
      artist.ID === Number(id) ||
      artist.ConstituentID === Number(id) ||
      artist.DisplayName === id ||
      (artist.DisplayName && artist.DisplayName.match(new RegExp(id, 'i')))
    )
  })

  const mixArtist = artistsMixNMatch.find(artist => {
    const tmsId = matchingArtist.ID || matchingArtist.ConstituentID
    return Number(artist.external_id) === Number(matchingArtist ? tmsId : id)
  })

  const artist = matchingArtist && {
    id: matchingArtist.ID || matchingArtist.ConstituentID,
    name: mixArtist ? mixArtist.name : matchingArtist.DisplayName,
    // TODO when artists are updated from TMS with Q number add that in here
    q: mixArtist ? mixArtist.q : matchingArtist.AltNum,
    beginDate: matchingArtist.BeginDate,
    endDate: matchingArtist.EndDate,
    description: matchingArtist.DisplayDate,
    nationality: matchingArtist.Nationality,
  }

  false &&
    console.info('people/:id', {
      id,
      matchingArtist,
      mixArtist,
      artist,
    })

  if (id && artist) {
    if (artist.q) {
      return wikidata(artist).then(wikidataInfo => {
        const article = wikidataInfo.article

        if (article) {
          const pageId = article && article.split('/')[4]

          return wikiArticle(pageId).then(json => {
            const wikiInfo = {
              link: json.content_urls && json.content_urls.desktop.page,
              thumbnail: json.thumbnail && json.thumbnail.source,
              extract: json.extract,
              description: json.description,
            }
            return res.json(
              Object.assign(artist, {
                wikipedia: wikiInfo,
                wikidata: wikidataInfo,
              })
            )
          })
        } else {
          // no wikipedia article, but some wikidata…
          return res.json(Object.assign(artist, { wikidata: wikidataInfo }))
        }
      })
    }

    return res.json(artist)
  }

  return res.status(404).json(null)
}
