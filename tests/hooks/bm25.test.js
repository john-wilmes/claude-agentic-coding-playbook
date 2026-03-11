#!/usr/bin/env node
// Integration tests for bm25.js — BM25 text search module.
// Zero dependencies — uses only Node built-ins.
//
// Run: node tests/hooks/bm25.test.js

const assert = require("assert");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const { tokenize, buildIndex, query } = require(
  path.join(REPO_ROOT, "templates", "hooks", "bm25.js")
);

// ─── Test runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`  \u2717 ${name}`);
    console.log(`    ${err.message}`);
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log("\nbm25.js:");

// Test 1: tokenize lowercases input
test("1. tokenize lowercases input", () => {
  const tokens = tokenize("Hello World FOO");
  assert.ok(tokens.every((t) => t === t.toLowerCase()), "All tokens should be lowercase");
  assert.ok(tokens.includes("hello"), "Should include 'hello'");
  assert.ok(tokens.includes("world"), "Should include 'world'");
  assert.ok(tokens.includes("foo"), "Should include 'foo'");
});

// Test 2: tokenize splits on non-alphanumeric characters
test("2. tokenize splits on non-alphanumeric characters", () => {
  const tokens = tokenize("foo-bar_baz.qux,quux");
  assert.ok(tokens.includes("foo"), "Should split on hyphen");
  assert.ok(tokens.includes("bar"), "Should split on hyphen");
  assert.ok(tokens.includes("baz"), "Should split on underscore");
  assert.ok(tokens.includes("qux"), "Should split on period");
  assert.ok(tokens.includes("quux"), "Should split on comma");
});

// Test 3: tokenize filters stopwords
test("3. tokenize filters stopwords", () => {
  const tokens = tokenize("the quick brown fox");
  assert.ok(!tokens.includes("the"), "Should filter stopword 'the'");
  assert.ok(tokens.includes("quick"), "Should keep 'quick'");
  assert.ok(tokens.includes("brown"), "Should keep 'brown'");
  assert.ok(tokens.includes("fox"), "Should keep 'fox'");
});

// Test 4: tokenize filters short tokens (< 2 chars)
test("4. tokenize filters short tokens (< 2 chars)", () => {
  const tokens = tokenize("a go to be x cat");
  assert.ok(!tokens.includes("a"), "Should filter single-char 'a'");
  assert.ok(!tokens.includes("x"), "Should filter single-char 'x'");
  // 'to' and 'be' are stopwords, already filtered
  assert.ok(tokens.includes("go"), "Should keep 2-char token 'go'");
  assert.ok(tokens.includes("cat"), "Should keep 'cat'");
});

// Test 5: buildIndex creates index with correct doc count
test("5. buildIndex creates index with correct doc count", () => {
  const docs = [
    { id: "a", text: "hello world" },
    { id: "b", text: "foo bar baz" },
    { id: "c", text: "quick brown fox" },
  ];
  const index = buildIndex(docs);
  assert.strictEqual(index.N, 3, "N should equal number of documents");
  assert.ok(index.docs.has("a"), "docs map should contain id 'a'");
  assert.ok(index.docs.has("b"), "docs map should contain id 'b'");
  assert.ok(index.docs.has("c"), "docs map should contain id 'c'");
});

// Test 6: buildIndex computes document frequencies correctly
test("6. buildIndex computes document frequencies correctly", () => {
  const docs = [
    { id: "a", text: "cat sat mat" },
    { id: "b", text: "cat on the mat" },
    { id: "c", text: "dog ran fast" },
  ];
  const index = buildIndex(docs);
  // 'cat' appears in doc a and b (2 docs)
  assert.strictEqual(index.df.get("cat"), 2, "df('cat') should be 2");
  // 'mat' appears in doc a and b (2 docs)
  assert.strictEqual(index.df.get("mat"), 2, "df('mat') should be 2");
  // 'dog' appears in only doc c (1 doc)
  assert.strictEqual(index.df.get("dog"), 1, "df('dog') should be 1");
  // 'sat' appears only in doc a (1 doc)
  assert.strictEqual(index.df.get("sat"), 1, "df('sat') should be 1");
});

// Test 7: buildIndex computes average document length
test("7. buildIndex computes average document length", () => {
  // Each doc has 3 tokens after tokenization (no stopwords/short tokens)
  const docs = [
    { id: "a", text: "cat sat mat" },   // 3 tokens
    { id: "b", text: "dog ran fast" },  // 3 tokens
    { id: "c", text: "fox big red" },   // 3 tokens
  ];
  const index = buildIndex(docs);
  assert.strictEqual(index.avgdl, 3, "avgdl should be 3");
});

// Test 8: query returns results sorted by score descending
test("8. query returns results sorted by score descending", () => {
  const docs = [
    { id: "a", text: "javascript node runtime" },
    { id: "b", text: "javascript browser dom event" },
    { id: "c", text: "python data science numpy" },
  ];
  const index = buildIndex(docs);
  const results = query(index, "javascript node", 3);
  assert.ok(results.length > 0, "Should return results");
  for (let i = 1; i < results.length; i++) {
    assert.ok(
      results[i - 1].score >= results[i].score,
      `Result ${i - 1} score (${results[i - 1].score}) should be >= result ${i} score (${results[i].score})`
    );
  }
});

// Test 9: query ranks relevant documents higher
test("9. query ranks relevant documents higher", () => {
  const docs = [
    { id: "relevant", text: "machine learning neural network deep learning training" },
    { id: "somewhat", text: "machine learning basics introduction" },
    { id: "unrelated", text: "cooking recipes pasta sauce garlic" },
  ];
  const index = buildIndex(docs);
  const results = query(index, "deep learning neural network", 3);
  assert.ok(results.length >= 2, "Should return at least 2 results");
  const ids = results.map((r) => r.id);
  const relevantIdx = ids.indexOf("relevant");
  const unrelatedIdx = ids.indexOf("unrelated");
  assert.ok(relevantIdx !== -1, "Relevant doc should appear in results");
  if (unrelatedIdx !== -1) {
    assert.ok(
      relevantIdx < unrelatedIdx,
      "Relevant doc should rank higher than unrelated doc"
    );
  }
  // The relevant doc should have a higher score than 'somewhat'
  const relevantScore = results.find((r) => r.id === "relevant").score;
  const somewhatResult = results.find((r) => r.id === "somewhat");
  if (somewhatResult) {
    assert.ok(
      relevantScore > somewhatResult.score,
      `'relevant' (${relevantScore}) should score higher than 'somewhat' (${somewhatResult.score})`
    );
  }
});

// Test 10: query returns empty array for no matches
test("10. query returns empty array for no matches", () => {
  const docs = [
    { id: "a", text: "cat sat mat" },
    { id: "b", text: "dog ran fast" },
  ];
  const index = buildIndex(docs);
  const results = query(index, "xyzzy quux frobnicate", 5);
  assert.deepStrictEqual(results, [], "Should return empty array when no terms match");
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);

if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  \u2717 ${f.name}: ${f.error}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
