'use strict';

/**
 * server.js — PHI-safe MongoDB MCP server
 *
 * Exposes three read-only tools:
 *   find                — query a collection with filter, projection, sort, limit
 *   aggregate           — run a read-only aggregation pipeline
 *   discover_collection — list all indexes for a collection
 *
 * PHI is stripped from all results by sanitizer.js before being returned to
 * the model. $out and $merge pipeline stages are blocked server-side.
 *
 * Required environment variable:
 *   MONGODB_URI — MongoDB connection string (injected by launch script)
 *
 * Optional environment variable:
 *   PHI_CONFIG_PATH — absolute path to phi-config.yaml (default: auto-discover)
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { MongoClient } = require('mongodb');

const {
  sanitizeDocuments,
  sanitizeProjection,
  filterPipeline,
} = require('./sanitizer.js');

// ── Configuration ─────────────────────────────────────────────────────────────

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  process.stderr.write('Fatal: MONGODB_URI environment variable is required\n');
  process.exit(1);
}

const DEFAULT_DATABASE = 'db';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const CONNECT_TIMEOUT_MS = 30000;

// ── MongoDB client (lazy) ─────────────────────────────────────────────────────

let _client = null;

async function getDb() {
  if (!_client) {
    _client = new MongoClient(MONGODB_URI, {
      connectTimeoutMS: CONNECT_TIMEOUT_MS,
      serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
    });
    await _client.connect();
  }
  return _client.db(DEFAULT_DATABASE);
}

// ── Error scrubbing ───────────────────────────────────────────────────────────

/**
 * Remove the MongoDB URI (which may contain credentials) from error messages.
 *
 * @param {Error|string} err
 * @returns {string}
 */
function scrubError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(MONGODB_URI, '[MONGODB_URI]');
}

// ── MCP server setup ──────────────────────────────────────────────────────────

const server = new Server(
  { name: 'mongodb-sanitizer', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// ── Tool definitions ──────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'find',
      description:
        'Query a MongoDB collection. PHI fields are stripped from all results. ' +
        'A filter is required — omitting it will be rejected to prevent full-collection scans. ' +
        'Use the hint parameter with a named index string to prevent collection scans. Call discover_collection first if you don\'t know which indexes exist.',
      inputSchema: {
        type: 'object',
        properties: {
          collection: {
            type: 'string',
            description: 'Collection name to query',
          },
          filter: {
            type: 'object',
            description: 'MongoDB query filter (required, must be a non-null object)',
          },
          projection: {
            type: 'object',
            description: 'MongoDB projection (optional). PHI fields are forced to 0.',
          },
          limit: {
            type: 'integer',
            description: `Maximum documents to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
          },
          sort: {
            type: 'object',
            description: 'MongoDB sort specification (optional)',
          },
          hint: {
            type: 'string',
            description: "Named MongoDB index to force (e.g. 'user_1_deleted_1_type_1'). Prevents collection scans. Get index names by calling discover_collection first.",
          },
        },
        required: ['collection', 'filter'],
      },
    },
    {
      name: 'aggregate',
      description:
        'Run a MongoDB aggregation pipeline. PHI fields are stripped from all results. ' +
        '$out and $merge stages are blocked (read-only).',
      inputSchema: {
        type: 'object',
        properties: {
          collection: {
            type: 'string',
            description: 'Collection name to aggregate',
          },
          pipeline: {
            type: 'array',
            description: 'MongoDB aggregation pipeline stages',
            items: { type: 'object' },
          },
        },
        required: ['collection', 'pipeline'],
      },
    },
    {
      name: 'discover_collection',
      description:
        'List all indexes for a MongoDB collection. Call this before querying an unfamiliar collection to find available index names for the hint parameter. Returns each index name, key pattern, and partial filter expression (if any). Always use an index hint when querying large collections.',
      inputSchema: {
        type: 'object',
        properties: {
          collection: {
            type: 'string',
            description: 'Collection name to inspect',
          },
        },
        required: ['collection'],
      },
    },
  ],
}));

// ── Tool handlers ─────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'find') {
      return await handleFind(args);
    } else if (name === 'aggregate') {
      return await handleAggregate(args);
    } else if (name === 'discover_collection') {
      return await handleDiscoverCollection(args);
    } else {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${scrubError(err)}` }],
      isError: true,
    };
  }
});

async function handleFind(args) {
  const { collection, filter, projection, limit, sort, hint } = args || {};

  // Validate inputs
  if (!collection || typeof collection !== 'string' || collection.trim() === '') {
    throw new Error('collection must be a non-empty string');
  }
  if (filter === null || filter === undefined || typeof filter !== 'object' || Array.isArray(filter)) {
    throw new Error('filter must be a non-null object');
  }

  const resolvedLimit = Math.min(
    typeof limit === 'number' && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT,
    MAX_LIMIT
  );

  const safeProjection = sanitizeProjection(projection, collection);

  const db = await getDb();
  let cursor = db.collection(collection).find(filter, { projection: safeProjection });
  if (sort && typeof sort === 'object') cursor = cursor.sort(sort);
  cursor = cursor.limit(resolvedLimit);
  if (hint && typeof hint === 'string') cursor = cursor.hint(hint);

  const raw = await cursor.toArray();
  const sanitized = await sanitizeDocuments(raw, collection);

  const summary = `Returned ${sanitized.length} document(s) from ${collection}.`;
  return {
    content: [
      { type: 'text', text: summary },
      { type: 'text', text: JSON.stringify(sanitized, null, 2) },
    ],
  };
}

async function handleAggregate(args) {
  const { collection, pipeline } = args || {};

  // Validate inputs
  if (!collection || typeof collection !== 'string' || collection.trim() === '') {
    throw new Error('collection must be a non-empty string');
  }
  if (!Array.isArray(pipeline)) {
    throw new Error('pipeline must be an array');
  }

  // Block write stages
  filterPipeline(pipeline);

  const db = await getDb();
  const raw = await db.collection(collection).aggregate(pipeline).toArray();
  const sanitized = await sanitizeDocuments(raw, collection);

  const summary = `Returned ${sanitized.length} result(s) from ${collection} aggregate.`;
  return {
    content: [
      { type: 'text', text: summary },
      { type: 'text', text: JSON.stringify(sanitized, null, 2) },
    ],
  };
}

async function handleDiscoverCollection(args) {
  const { collection } = args || {};
  if (!collection || typeof collection !== 'string' || collection.trim() === '') {
    throw new Error('collection must be a non-empty string');
  }
  const db = await getDb();
  const indexes = await db.collection(collection).indexes();

  const lines = [`Indexes for collection "${collection}" (${indexes.length} total):\n`];
  for (const idx of indexes) {
    const keyStr = Object.entries(idx.key).map(([k, v]) => `${k}: ${v}`).join(', ');
    lines.push(`  name: "${idx.name}"`);
    lines.push(`  key:  { ${keyStr} }`);
    if (idx.partialFilterExpression) {
      lines.push(`  partialFilter: ${JSON.stringify(idx.partialFilterExpression)}`);
      lines.push(`  ⚠ This is a partial index — your filter MUST include the partialFilter fields exactly.`);
    }
    if (idx.unique) lines.push(`  unique: true`);
    lines.push('');
  }
  lines.push('Usage: pass the index name string as the hint parameter in find calls.');
  lines.push('Example: { collection: "' + collection + '", filter: {...}, hint: "' + (indexes[1]?.name || indexes[0]?.name) + '" }');

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

// ── Start server ──────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('mongodb-sanitizer MCP server running\n');
}

main().catch(err => {
  process.stderr.write(`Fatal: ${scrubError(err)}\n`);
  process.exit(0); // exit 0 — hooks must never crash with non-zero
});
