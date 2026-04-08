/**
 * kb_supabase.js — MetaBUS Knowledge Base (Supabase version)
 *
 * Drop-in replacement for kb.js, backed by Supabase PostgreSQL + pgvector.
 * Copy this file into your Next.js project (e.g. lib/kb.js).
 *
 * Requires:
 *   npm install @supabase/supabase-js openai
 *
 * Env vars (in .env.local for Next.js):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_KEY   (server-side only — never expose to browser)
 *   OPENAI_API_KEY         (for semantic search embeddings)
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

// ── client singletons ─────────────────────────────────────────────────────────

let _supabase = null;
let _openai   = null;

function supabase() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
    );
  }
  return _supabase;
}

function openai() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

function clampR(val) {
  return Math.min(1, Math.max(0, parseFloat(val) || 0));
}

// ─────────────────────────────────────────────────────────────
// Construct queries
// ─────────────────────────────────────────────────────────────

/**
 * Look up a single construct by id.
 * @returns {{ id, name, parent_id, depth, path, budget } | null}
 */
async function getConstruct(id) {
  const { data, error } = await supabase()
    .from('constructs')
    .select('id, name, parent_id, depth, path, budget')
    .eq('id', id)
    .single();

  if (error) return null;
  return data;
}

/**
 * SQL keyword search — fast, matches construct name substrings.
 * Use for autocomplete / exact-ish term lookup.
 */
async function searchConstructs(query, limit = 20) {
  const { data, error } = await supabase()
    .from('constructs')
    .select('id, name, parent_id, depth, path, budget')
    .ilike('name', `%${query}%`)
    .order('budget', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`searchConstructs: ${error.message}`);
  return data || [];
}

/**
 * Semantic search — embeds the query and finds the closest constructs
 * using pgvector cosine similarity.
 *
 * Use when a keyword won't match the construct name directly
 * e.g. "stress" → "Emotional exhaustion", "Burnout", "Work strain"
 *
 * @param {string}  query           – natural language keyword or phrase
 * @param {object}  opts
 * @param {number}  opts.limit      – max results (default 10)
 * @param {number}  opts.threshold  – min similarity 0..1 (default 0.5)
 * @returns {Array<{ id, name, path, depth, budget, similarity }>}
 */
async function searchConstructSemantic(query, { limit = 10, threshold = 0.5 } = {}) {
  // Embed the query using the same model as embed_constructs.js
  const embeddingResponse = await openai().embeddings.create({
    model: 'text-embedding-3-small',
    input: query,
  });
  const queryEmbedding = embeddingResponse.data[0].embedding;

  // Call the match_constructs SQL function defined in migration.sql
  const { data, error } = await supabase().rpc('match_constructs', {
    query_embedding: queryEmbedding,
    match_threshold: threshold,
    match_count:     limit,
  });

  if (error) throw new Error(`searchConstructSemantic: ${error.message}`);
  return (data || []).map(row => ({ ...row, similarity: parseFloat(row.similarity) }));
}

/**
 * Return top-level OB/HR domains (depth = 1), ordered by correlation count.
 */
async function getTopLevelDomains() {
  // Use a raw RPC or two queries — Supabase JS doesn't support JOIN aggregates inline
  const { data, error } = await supabase()
    .from('constructs')
    .select('id, name, budget')
    .eq('depth', 1)
    .order('budget', { ascending: false });

  if (error) throw new Error(`getTopLevelDomains: ${error.message}`);
  return data || [];
}

/**
 * Children of a given parent construct.
 */
async function getChildConstructs(parentId) {
  const { data, error } = await supabase()
    .from('constructs')
    .select('id, name, depth, path, budget')
    .eq('parent_id', parentId)
    .order('budget', { ascending: false });

  if (error) throw new Error(`getChildConstructs: ${error.message}`);
  return data || [];
}

// ─────────────────────────────────────────────────────────────
// Correlation queries
// ─────────────────────────────────────────────────────────────

/**
 * Get top correlated constructs (bidirectional) for a given construct.
 * Uses the get_top_correlates SQL function from migration.sql.
 *
 * @param {number} constructId
 * @param {object} opts
 * @param {number} opts.limit       – max results (default 10)
 * @param {number} opts.minKEffects – minimum effect sizes required (default 3)
 * @param {string} opts.source      – 'OB', 'L56', or null for both
 * @returns {Array<{ target_id, target_name, abs_r, r, k_effects, source }>}
 */
async function getTopCorrelates(constructId, { limit = 10, minKEffects = 3, source = null } = {}) {
  const { data, error } = await supabase().rpc('get_top_correlates', {
    p_construct_id: constructId,
    p_min_k:        minKEffects,
    p_limit:        limit,
    p_source:       source,
  });

  if (error) throw new Error(`getTopCorrelates: ${error.message}`);
  return (data || []).map(row => ({ ...row, abs_r: clampR(row.abs_r) }));
}

/**
 * Pre-aggregated stats for a construct.
 * @returns {{ construct_id, n_outgoing, n_incoming, avg_abs_r_in, max_abs_r_in, ... } | null}
 */
async function getConstructStats(constructId) {
  const { data, error } = await supabase()
    .from('construct_stats')
    .select('*')
    .eq('construct_id', constructId)
    .single();

  if (error) return null;
  return {
    ...data,
    avg_abs_r_out:     clampR(data.avg_abs_r_out),
    avg_abs_r_in:      clampR(data.avg_abs_r_in),
    max_abs_r_out:     clampR(data.max_abs_r_out),
    max_abs_r_in:      clampR(data.max_abs_r_in),
    top_correlated_ids: data.top_correlated_ids || [],
  };
}

// ─────────────────────────────────────────────────────────────
// Core interface for Claude — getConstructContext
// ─────────────────────────────────────────────────────────────

/**
 * Build the context bundle that Claude needs to generate a survey question.
 *
 * This is the PRIMARY function your friend's code should call.
 *
 * @param {number} constructId
 * @param {object} opts
 * @param {number} opts.topN         – number of correlates to include (default 5)
 * @param {number} opts.minKEffects  – min effect sizes for correlates (default 5)
 * @returns {{
 *   construct: { id, name, path, domain, depth },
 *   top_correlates: Array<{ name, abs_r, r, k_effects, direction }>,
 *   stats: { n_incoming, avg_abs_r_in, max_abs_r_in, total_k_effects },
 *   evidence_strength: 'strong' | 'moderate' | 'limited'
 * }}
 */
async function getConstructContext(constructId, { topN = 5, minKEffects = 5 } = {}) {
  const [construct, correlates, stats] = await Promise.all([
    getConstruct(constructId),
    getTopCorrelates(constructId, { limit: topN, minKEffects }),
    getConstructStats(constructId),
  ]);

  if (!construct) throw new Error(`Construct ${constructId} not found`);

  // Derive top-level domain from path
  const domain = construct.path
    ? construct.path.split(' > ')[0]
    : 'Unknown';

  // Classify evidence strength based on total k_effects
  const totalK = stats?.total_k_effects || 0;
  const evidenceStrength =
    totalK >= 1000 ? 'strong' :
    totalK >= 100  ? 'moderate' : 'limited';

  return {
    construct: {
      id:     construct.id,
      name:   construct.name,
      path:   construct.path,
      domain,
      depth:  construct.depth,
    },
    top_correlates: correlates.map(c => ({
      name:      c.target_name,
      abs_r:     c.abs_r,
      r:         parseFloat(c.r) || 0,
      k_effects: c.k_effects,
      direction: (parseFloat(c.r) || 0) >= 0 ? 'positive' : 'negative',
    })),
    stats: {
      n_incoming:      stats?.n_incoming      || 0,
      avg_abs_r_in:    stats?.avg_abs_r_in    || 0,
      max_abs_r_in:    stats?.max_abs_r_in    || 0,
      total_k_effects: totalK,
    },
    evidence_strength: evidenceStrength,
  };
}

// ─────────────────────────────────────────────────────────────
// Adaptive branching
// ─────────────────────────────────────────────────────────────

/**
 * Given a normalised score (0..1) on a construct, return which
 * constructs to probe next, based on correlation strength.
 *
 * Branching rules:
 *   strong  (abs_r >= 0.30) → follow all strong correlates (scaled by score)
 *   moderate (0.15..0.29)   → follow top-3
 *   weak    (<0.15)         → follow only the single strongest
 *
 * @param {number} constructId
 * @param {number} score     – normalised 0..1 (from survey response)
 * @param {Set}    visited   – construct ids already covered this session
 */
async function getNextConstructs(constructId, score, visited = new Set()) {
  const correlates = await getTopCorrelates(constructId, { limit: 10, minKEffects: 3 });
  const unseen = correlates.filter(
    c => !visited.has(c.target_id) && c.target_id !== constructId
  );

  const strong   = unseen.filter(c => c.abs_r >= 0.30);
  const moderate = unseen.filter(c => c.abs_r >= 0.15 && c.abs_r < 0.30);

  let next = [];
  if (strong.length > 0) {
    const take = Math.max(1, Math.round(score * strong.length));
    next = strong.slice(0, take);
  } else if (moderate.length > 0) {
    const take = Math.max(1, Math.round(score * Math.min(3, moderate.length)));
    next = moderate.slice(0, take);
  } else if (unseen.length > 0) {
    next = [unseen[0]];
  }

  return next;
}

// ─────────────────────────────────────────────────────────────
// Benchmarking
// ─────────────────────────────────────────────────────────────

/**
 * Benchmark a raw Likert score (1..5) against population norms.
 * Assumes: mean=3, sd=0.8 (typical OB survey distribution).
 *
 * @param {number} constructId
 * @param {number} score – raw 1..5 Likert mean
 */
async function benchmarkScore(constructId, score) {
  const stats = await getConstructStats(constructId);
  const norm  = stats ? clampR(stats.avg_abs_r_in) : 0.2;

  const mean = 3, sd = 0.8;
  const z    = (score - mean) / sd;
  const percentile = Math.round(100 * (0.5 * (1 + erf(z / Math.SQRT2))));

  let label, interpretation;
  if      (percentile >= 75) { label = 'High';          interpretation = 'Well above average — potential strength'; }
  else if (percentile >= 50) { label = 'Moderate-High'; interpretation = 'Slightly above average'; }
  else if (percentile >= 25) { label = 'Moderate-Low';  interpretation = 'Below average — monitor'; }
  else                       { label = 'Low';           interpretation = 'Well below average — priority area'; }

  return { percentile, label, norm_avg_r: norm, interpretation };
}

// ─────────────────────────────────────────────────────────────
// Org health summary
// ─────────────────────────────────────────────────────────────

/**
 * Compute overall org health from a session's scored constructs.
 *
 * @param {Map<number, { construct_name, raw_score }>} scores
 */
async function computeOrgHealth(scores) {
  const domains = {};
  let total = 0, count = 0;

  for (const [constructId, entry] of scores) {
    const construct = await getConstruct(constructId);
    if (!construct) continue;

    const domain = construct.path
      ? construct.path.split(' > ')[0]
      : 'Other';

    if (!domains[domain]) domains[domain] = { scores: [], constructs: [] };
    domains[domain].scores.push(entry.raw_score);
    domains[domain].constructs.push({
      id: constructId, name: construct.name, score: entry.raw_score
    });
    total += entry.raw_score;
    count++;
  }

  const domain_summaries = Object.entries(domains).map(([name, data]) => ({
    domain:           name,
    avg_score:        data.scores.reduce((a, b) => a + b, 0) / data.scores.length,
    construct_count:  data.constructs.length,
    constructs:       data.constructs.sort((a, b) => a.score - b.score), // lowest = priorities
  })).sort((a, b) => a.avg_score - b.avg_score);

  return {
    overall_avg:               count > 0 ? total / count : null,
    domain_summaries,
    total_constructs_assessed: count,
  };
}

// ─────────────────────────────────────────────────────────────
// Utility: resolve keyword to construct (tries SQL then semantic)
// ─────────────────────────────────────────────────────────────

/**
 * Find the best matching construct for a keyword.
 * Tries SQL first (fast), falls back to semantic search.
 * This is useful for Claude to resolve construct mentions to IDs.
 *
 * @param {string} keyword
 * @returns {{ id, name, path, match_type: 'exact'|'sql'|'semantic' } | null}
 */
async function resolveKeywordToConstruct(keyword) {
  // 1. Try exact match first
  const exact = await searchConstructs(keyword, 5);
  const exactMatch = exact.find(c =>
    c.name.toLowerCase() === keyword.toLowerCase()
  );
  if (exactMatch) return { ...exactMatch, match_type: 'exact' };

  // 2. Try SQL substring
  if (exact.length > 0) return { ...exact[0], match_type: 'sql' };

  // 3. Fall back to semantic search
  const semantic = await searchConstructSemantic(keyword, { limit: 3, threshold: 0.4 });
  if (semantic.length > 0) return { ...semantic[0], match_type: 'semantic' };

  return null;
}

// ── error function (used by benchmarkScore) ───────────────────────────────────
function erf(x) {
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741,
        a4=-1.453152027, a5=1.061405429, p=0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t) * Math.exp(-x*x);
  return sign * y;
}

// ─────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────

module.exports = {
  // Primary interface for Claude
  getConstructContext,
  resolveKeywordToConstruct,

  // Adaptive survey engine
  getNextConstructs,
  benchmarkScore,
  computeOrgHealth,

  // Search
  searchConstructs,
  searchConstructSemantic,

  // Direct lookups
  getConstruct,
  getTopCorrelates,
  getConstructStats,
  getTopLevelDomains,
  getChildConstructs,
};
