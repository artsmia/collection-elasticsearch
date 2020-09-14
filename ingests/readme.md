<!-- @format -->

My idea for how this works is a collection of "ingests". An ingest is a source
that provides data to be ingested into mia's elasticsearch. This would look
something like:

- ingests/
  - mia
    - collection
    - artists
    - foot-in-the-door
    - related (should this get it's own place, in addition to being pinned into `collection`?)
  - other
    - rijksmuseum
    - cooperhewitt
    - wikidata
    - …

Each ingest ('ingester'?) would be a javascript file that transforms data to some degree of
similarity (likely modifying a set of fields deemed "core" so they all match,
and maybe leaving different data in place for different sources?)

An ingest assembles and formats data that can be bulk uploaded to its destination(s), or streamed from a live data source to keep the destination(s) updated in real time.

Destinations:

- Elasticsearch index for searching data (bulk, daily, live updates)
- github data sink (bulk, daily)
- wikidata (bulk, daily. Maybe live?)
- ?

Still working this around in my head. Are destinations tied to specific ingests, or defined at the top level and somehow then consumed by an ingest along with how the data gets exported?
