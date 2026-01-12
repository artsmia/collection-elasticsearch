Elasticsearch for Mia's collection data.

# Setup (DDev)

```
ddev start

# populate local redis
docker run --rm -ti \
  --network ddev-collection-elasticsearch_default \
  -v ./tmp:/app  -w /app \
  riotx/riot file-import -h redis redis-riot-export.2025-07-09.json

# redis-cli example usage
ddev exec -s redis redis-cli info

# populate local OpenSearch
docker run --rm -ti \
  --network ddev-collection-elasticsearch_default \
  -v ./tmp:/app -w /app \
  elasticdump/elasticsearch-dump \
    --input=2025-07-09-object2.mapping.json \
    --output='http://admin:97UxngYAArZ12jqt!jH20K@opensearch:9200/objects2' \
    --type=mapping

docker run --rm -ti \
  --network ddev-collection-elasticsearch_default \
  -v ./tmp:/app -w /app \
  elasticdump/elasticsearch-dump \
    --input=2025-07-09-object2.data.json \
    --output='http://admin:97UxngYAArZ12jqt!jH20K@opensearch:9200/objects2' \
    --type=data

# verify index now exists
curl 'http://admin:97UxngYAArZ12jqt!jH20K@localhost:9200/objects2' | jq .

curl 'http://admin:97UxngYAArZ12jqt!jH20K@localhost:9200/objects2/_doc/3885 | jq .

# Start the server on http://localhost:3000/
ddev exec -s app node api/index.js
```

# Setup (legacy)

(Getting this all running requires that you have a local redis instance
that's replicating our internal museum redis. [You can create your own from
our open data](https://github.com/artsmia/collection/blob/f9eebd151d663939d57177515d2f8ef86e1d7474/Makefile#L96-L103))

1. Install `elasticsearch`: `brew install homebrew/versions/elasticsearch17`
2. [Enable `groovy` scripting for `aggregations`](https://discuss.elastic.co/t/scripts-of-type-inline-operation-aggs-and-lang-groovy-are-disabled/2493/2)
3. Start elasticsearch.
4. Build the index: `make clean createIndex update`

# Search

The search looks at the following "fields" for each artwork. `Boost`
determines how important that particular field is.

`field` | `boost` | description
--- | :---: | ---
artist.artist | 15 | the artist
artist.folded | 15 | artist with special characters (é, ü, …) replaced with 'normal' 'english' letters
title | 11 | the title of an artwork
description | 3 | the "registrar" description of the artwork - how it was describes when accessioned
text | 2 | "curatorial" text, the general label written about this work
accession_number | | object "accession number"
\_all | | all the fields in the record combined together, so nothing gets missed
artist.ngram | 2 | artist's name, **ngram**med
title.ngram | | artwork title, **ngram**med

**ngram**s break search terms down into sub-word *grams*. So a
search for [`o'keefe`](https://collections.artsmia.org/search/o'keefe)
returns results for "Georgia O'Keffee" even when it's spelled differently.

Then there are "ranking functions" applied to the results. A few
examples:

```js
{filter: {term: {highlight: 'true'}}, weight: 3},
{filter: {term: {image: 'valid'}}, weight: 2},
{filter: {prefix: {room: 'g'}}, weight: 1.1},
```

…if it's a highlight, boost it by 3; if it has a valid image, 2; if it's
currently on view, 1.1.

This all happens within a [function score
query](https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl-function-score-query.html).

# API

Here are the main endpoints we use. Test them out at [search.artsmia.org](https://search.artsmia.org).

`endpoint` | description | example
-- | -- | --
`/:query` | searches for the given text, using [ES query string syntax](https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl-query-string-query.html#query-string-syntax) | [horses from China](http://search.artsmia.org/horse%20country:%22China%22)
`/id/:id` | JSON for a single object by id | [Olive Trees, Vincent Van Gogh](https://search.artsmia.org/id/1218)
`/ids/:ids` | multiple objects by id | [two personal favorites](https://search.artsmia.org/ids/13611,99789)
`/random/art` | return one or more random artworks, matching an optional query | [ten random artworks, currently displayed on the Museum's 3rd floor](https://search.artsmia.org/random/art?size=10&q=room:G3*)

# Indexing

We index our objects regularly from our custom-built TMS API. See [`Makefile`](Makefile) for the confusing, shell-scripted details. It works by pulling the data from a local redis database that's synchronized with a system that watches for changes as they happen in TMS. We also index [related content](https://github.com/artsmia/collection-info) to our objects. A few other layers of data are added into elasticsearch to complement and improve the data from our API.

## Setup for working with OpenSearch

```
export OS_URL_NO_AUTH='https://search-test-site-...us-east-1.es.amazonaws.com'
export OS_PASSWORD='...'
```

### Extracting the index

```
curl -u "admin:${OS_PASSWORD}" "${OS_URL_NO_AUTH}/objects2" | jq .objects2 > objects2.json
```

### Recreating it

First, remove a few fields from the settings:

```
cat objects2.json \
  | jq 'del(.settings.index.provided_name)' \
  | jq 'del(.settings.index.uuid)' \
  | jq 'del(.settings.index.version)' \
  | jq 'del(.settings.index.creation_date)' \
  > new-objects2.json
```

Delete and recreate the index

```
curl -X DELETE -u "admin:${OS_PASSWORD}" "${OS_URL_NO_AUTH}/objects2"

curl -X PUT -u "admin:${OS_PASSWORD}" "${OS_URL_NO_AUTH}/objects2" \
-H "Content-Type: application/json" \
-d @new-objects2.json
```
