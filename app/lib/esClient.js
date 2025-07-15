const { Client } = require('@opensearch-project/opensearch');

/** @type {import('@opensearch-project/opensearch').ClientOptions} */
const esOptions = {
  node: process.env.ES_URL,
  auth: {
    username: process.env.ES_USERNAME,
    password: process.env.ES_PASSWORD,
  },
  requestTimeout: 500,
};

if (process.env.IS_LOCAL) {
  esOptions.ssl = {
    rejectUnauthorized: false,
    checkServerIdentity: () => undefined,
  };
}

const esClient = new Client(esOptions);

module.exports = esClient;
