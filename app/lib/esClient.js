const { Client } = require('@opensearch-project/opensearch');

const url = new URL(process.env.ES_URL_NO_AUTH);
if (process.env.ES_PASSWORD) {
  url.username = process.env.ES_USERNAME;
  url.password = process.env.ES_PASSWORD;
}

/** @type {import('@opensearch-project/opensearch').ClientOptions} */
const esOptions = {
  node: url.toString(),
  requestTimeout: 3000,
};

const esClient = new Client(esOptions);

module.exports = esClient;

/**
 * Note: in the original legacy elasticsearch package, the connection was
 * set up this way (there are no docs for this):
 *
 * host: {
 *   host: 'opensearch',
 *   port: 9200,
 *   protocol: 'https',
 *   auth: `${process.env.ES_USERNAME}:${process.env.ES_PASSWORD}`,
 * },
 */
