/**
 * @format
 * Verify and fix records flagged with `image: "valid"` whose image renditions
 * return 403 / 404 on the CDN. (Fixes Issue #10)
 */

const https = require('https');
const http = require('http');

// 40 known stale IDs documented in Issue #10
const KNOWN_STALE_IMAGE_IDS = [
  2609, 5047, 5049, 5050, 5146, 10465, 10472, 31245, 35148, 60598, 60599, 62711,
  107003, 112877, 124648, 137806, 142666, 143405, 143758, 144054, 144056, 144462,
  144628, 145821, 146216, 146247, 146536, 147772, 147881, 148083, 148177, 148529,
  149009, 149024, 149390, 150684, 150686, 150688, 150692, 151105,
];

/**
 * Check whether an image exists on Mia's image CDN
 * @param {number|string} id - Artwork ID
 * @param {string} [size='400'] - Rendition size (e.g. '400', '800', 'full')
 * @returns {Promise<{ id: number|string, exists: boolean, statusCode: number }>}
 */
function verifyImage(id, size = '400') {
  return new Promise((resolve) => {
    const url = `https://1.api.artsmia.org/${size}/${id}.jpg`;
    const req = https.request(
      url,
      { method: 'HEAD', timeout: 8000, headers: { 'User-Agent': 'artsmia-image-verifier/1.0' } },
      (res) => {
        resolve({
          id,
          exists: res.statusCode === 200,
          statusCode: res.statusCode,
          url,
        });
      }
    );

    req.on('error', (err) => {
      resolve({ id, exists: false, statusCode: 0, error: err.message, url });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ id, exists: false, statusCode: 408, error: 'Request timeout', url });
    });

    req.end();
  });
}

/**
 * Audit a list of artwork IDs with controlled concurrency
 * @param {Array<number|string>} ids
 * @param {number} [concurrency=10]
 * @returns {Promise<{ valid: Array<any>, invalid: Array<any> }>}
 */
async function auditImages(ids, concurrency = 10) {
  const invalid = [];
  const valid = [];
  const queue = [...ids];

  async function worker() {
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) break;
      const result = await verifyImage(id);
      if (result.exists) {
        valid.push(result);
      } else {
        invalid.push(result);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, ids.length) }, () => worker());
  await Promise.all(workers);

  return { valid, invalid };
}

/**
 * Build OpenSearch / ElasticSearch NDJSON bulk update payload
 * @param {Array<number|string>} ids
 * @param {string} [index]
 * @param {string} [type='object_data']
 * @returns {string}
 */
function buildBulkUpdatePayload(ids, index = process.env.OS_INDEX || 'objects2', type = 'object_data') {
  return ids
    .map((id) => {
      const action = { update: { _index: index, _type: type, _id: String(id) } };
      const doc = { doc: { image: 'invalid' } };
      return `${JSON.stringify(action)}\n${JSON.stringify(doc)}`;
    })
    .join('\n') + '\n';
}

/**
 * Apply fix directly to OpenSearch / Redis if clients are available
 * @param {Array<number|string>} ids
 */
async function applyFix(ids) {
  console.log(`Applying image: "invalid" flag to ${ids.length} records...`);

  let esClient;
  try {
    esClient = require('../../lib/esClient');
  } catch (e) {
    // lib/esClient not configured
  }

  if (esClient && process.env.OS_URL_NO_AUTH) {
    const index = process.env.OS_INDEX || 'objects2';
    const operations = ids.flatMap((id) => [
      { update: { _index: index, _id: String(id) } },
      { doc: { image: 'invalid' } },
    ]);

    try {
      const response = await esClient.bulk({ body: operations });
      if (response.body && response.body.errors) {
        console.warn('Some OpenSearch bulk updates had errors:', response.body.items);
      } else {
        console.log(`Successfully updated ${ids.length} records in OpenSearch index "${index}".`);
      }
    } catch (err) {
      console.error('Failed to update OpenSearch:', err.message);
    }
  } else {
    console.log('OpenSearch environment variables not set; skipping direct OpenSearch update.');
  }

  let buildRedisClient;
  try {
    buildRedisClient = require('../../lib/buildRedisClient');
  } catch (e) {
    // redis client not configured
  }

  if (buildRedisClient && process.env.REDIS_URL) {
    try {
      const redis = buildRedisClient();
      await redis.connect();
      for (const id of ids) {
        const bucket = Math.floor(Number(id) / 1000);
        const key = `object:${bucket}`;
        const raw = await redis.hGet(key, String(id));
        if (raw) {
          const parsed = JSON.parse(raw);
          parsed.image = 'invalid';
          await redis.hSet(key, String(id), JSON.stringify(parsed));
        }
      }
      console.log(`Successfully updated ${ids.length} records in Redis.`);
      await redis.quit();
    } catch (err) {
      console.error('Failed to update Redis:', err.message);
    }
  } else {
    console.log('REDIS_URL not set; skipping direct Redis update.');
  }
}

// CLI Execution
async function main() {
  const args = process.argv.slice(2);
  const isFix = args.includes('--fix');
  const isBulkJson = args.includes('--bulk-json');
  const idsArg = args.find((a) => a.startsWith('--ids='));

  let targetIds = KNOWN_STALE_IMAGE_IDS;
  if (idsArg) {
    targetIds = idsArg
      .replace('--ids=', '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  if (isBulkJson) {
    process.stdout.write(buildBulkUpdatePayload(targetIds));
    return;
  }

  console.log(`Auditing ${targetIds.length} records for image availability...`);
  const { valid, invalid } = await auditImages(targetIds);

  console.log(`\nAudit Results:`);
  console.log(`  Total checked: ${targetIds.length}`);
  console.log(`  Valid images:  ${valid.length}`);
  console.log(`  Missing / 403: ${invalid.length}`);

  if (invalid.length > 0) {
    console.log(`\nMissing image IDs (${invalid.length}):`);
    console.log(invalid.map((x) => x.id).join(' '));
  }

  if (isFix && invalid.length > 0) {
    await applyFix(invalid.map((x) => x.id));
  } else if (!isFix && invalid.length > 0) {
    console.log(`\nTo update these records in OpenSearch/Redis, run with --fix or use --bulk-json with curl.`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = {
  KNOWN_STALE_IMAGE_IDS,
  verifyImage,
  auditImages,
  buildBulkUpdatePayload,
  applyFix,
};
