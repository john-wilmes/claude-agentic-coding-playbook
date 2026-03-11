// BM25 (Best Matching 25) text search module.
// Pure Node stdlib — no npm packages required.
// Exports: tokenize, buildIndex, query

const STOPWORDS = new Set([
  "the", "is", "at", "which", "on", "a", "an", "in", "for", "to", "of",
  "and", "or", "but", "not", "with", "by", "from", "as", "be", "was",
  "were", "been", "are", "have", "has", "had", "do", "does", "did",
  "will", "would", "could", "should", "may", "might", "can", "shall",
  "this", "that", "these", "those", "it", "its", "i", "you", "he", "she",
  "we", "they", "me", "him", "her", "us", "them", "my", "your", "his",
  "our", "their", "what", "who", "how", "when", "where", "why", "if",
  "then", "else", "so", "no", "yes", "all", "each", "every", "both",
  "few", "more", "most", "other", "some", "such", "only", "same", "than",
  "too", "very",
]);

// BM25 hyperparameters
const K1 = 1.2;
const B = 0.75;

/**
 * Tokenize a string: lowercase, split on non-alphanumeric chars,
 * filter stopwords and tokens shorter than 2 characters.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  if (!text || typeof text !== "string") return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/**
 * Build a BM25 index from an array of documents.
 * @param {{ id: string, text: string }[]} documents
 * @returns {{ docs: Map, df: Map, avgdl: number, N: number }}
 */
function buildIndex(documents) {
  // docs: id → { tokens: string[], tf: Map<term, count>, length: number }
  const docs = new Map();
  // df: term → number of documents containing that term
  const df = new Map();
  let totalLength = 0;

  for (const doc of documents) {
    const tokens = tokenize(doc.text || "");
    const tf = new Map();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }
    docs.set(doc.id, { tokens, tf, length: tokens.length });
    totalLength += tokens.length;

    // Update document frequency (count each term once per document)
    for (const term of tf.keys()) {
      df.set(term, (df.get(term) || 0) + 1);
    }
  }

  const N = documents.length;
  const avgdl = N > 0 ? totalLength / N : 0;

  return { docs, df, avgdl, N };
}

/**
 * Query the BM25 index and return the top K results.
 * @param {{ docs: Map, df: Map, avgdl: number, N: number }} index
 * @param {string} queryText
 * @param {number} topK
 * @returns {{ id: string, score: number }[]}
 */
function query(index, queryText, topK = 5) {
  const { docs, df, avgdl, N } = index;
  if (N === 0) return [];

  const queryTokens = tokenize(queryText);
  if (queryTokens.length === 0) return [];

  const scores = new Map();

  for (const term of queryTokens) {
    const n = df.get(term) || 0;
    if (n === 0) continue;

    // IDF with smoothing: ln((N - n + 0.5) / (n + 0.5) + 1)
    const idf = Math.log((N - n + 0.5) / (n + 0.5) + 1);

    for (const [id, doc] of docs) {
      const f = doc.tf.get(term) || 0;
      if (f === 0) continue;

      // BM25 term score
      const denom = f + K1 * (1 - B + B * (doc.length / avgdl));
      const termScore = idf * (f * (K1 + 1)) / denom;

      scores.set(id, (scores.get(id) || 0) + termScore);
    }
  }

  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

module.exports = { tokenize, buildIndex, query };
