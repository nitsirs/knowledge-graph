/**
 * kb.js — MetaBUS Knowledge Base access layer
 *
 * Wraps the SQLite database with query helpers used by the survey engine.
 * abs_r values are clamped to [0, 1] to handle meta-analytic overcorrection.
 */

'use strict';

const path     = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(__dirname, '../kb/metabus_kb.db');

let _db = null;

function db() {
  if (!_db) _db = new Database(DB_PATH, { readonly: true });
  return _db;
}

function clampR(val) {
  return Math.min(1, Math.max(0, val));
}

// ─────────────────────────────────────────────────────────────
// Construct queries
// ─────────────────────────────────────────────────────────────

/** Return all constructs sorted by budget desc (proxy for research depth). */
function getAllConstructs() {
  return db().prepare(`
    SELECT id, name, parent_id, depth, path, budget
    FROM constructs
    ORDER BY budget DESC
  `).all();
}

/** Look up a single construct by id. */
function getConstruct(id) {
  return db().prepare('SELECT * FROM constructs WHERE id = ?').get(id) || null;
}

/** Fuzzy search constructs by name (case-insensitive substring). */
function searchConstructs(query, limit = 20) {
  return db().prepare(`
    SELECT id, name, parent_id, depth, path, budget
    FROM constructs
    WHERE LOWER(name) LIKE '%' || LOWER(?) || '%'
    ORDER BY budget DESC
    LIMIT ?
  `).all(query, limit);
}

/**
 * Return the top-level OB/HR domains (depth = 1).
 * Useful as the starting menu in the survey.
 */
function getTopLevelDomains() {
  return db().prepare(`
    SELECT DISTINCT c.id, c.name, c.budget,
           COUNT(corr.id) AS correlation_count
    FROM constructs c
    JOIN correlations corr ON corr.search_id = c.id OR corr.target_id = c.id
    WHERE c.depth = 1
    GROUP BY c.id
    ORDER BY correlation_count DESC
  `).all();
}

/**
 * Return constructs at a given depth that are children of parentId.
 */
function getChildConstructs(parentId) {
  return db().prepare(`
    SELECT id, name, depth, path, budget
    FROM constructs
    WHERE parent_id = ?
    ORDER BY budget DESC
  `).all(parentId);
}

// ─────────────────────────────────────────────────────────────
// Correlation queries
// ─────────────────────────────────────────────────────────────

/**
 * Strongest correlates for a given construct (outgoing from search_id).
 * Returns up to `limit` rows sorted by abs_r descending.
 * Filters out abs_r > 1 (overcorrected meta-analytic values) and self-loops.
 *
 * @param {number} constructId
 * @param {object} opts
 * @param {number} opts.limit
 * @param {number} opts.minKEffects – minimum number of effect sizes required
 * @param {string|null} opts.source – 'OB', 'L56', or null for both
 */
function getTopCorrelates(constructId, { limit = 10, minKEffects = 3, source = null } = {}) {
  const sourceClause = source ? `AND source = '${source}'` : '';
  // Bidirectional: look in both outgoing (search_id) and incoming (target_id) directions
  const rows = db().prepare(`
    SELECT peer_id, peer_name, MAX(abs_r) AS abs_r, r, MAX(k_effects) AS k_effects, k_samples, source
    FROM (
      SELECT target_id AS peer_id, target_name AS peer_name, abs_r, r, k_effects, k_samples, source
      FROM correlations
      WHERE search_id = ?
        AND target_id != ?
        AND abs_r <= 1.0
        AND abs_r > 0
        AND k_effects >= ?
        ${sourceClause}
      UNION ALL
      SELECT search_id AS peer_id, search_name AS peer_name, abs_r, r, k_effects, k_samples, source
      FROM correlations
      WHERE target_id = ?
        AND search_id != ?
        AND abs_r <= 1.0
        AND abs_r > 0
        AND k_effects >= ?
        ${sourceClause}
    )
    GROUP BY peer_id
    ORDER BY abs_r DESC
    LIMIT ?
  `).all(constructId, constructId, minKEffects,
         constructId, constructId, minKEffects,
         limit);

  return rows.map(row => ({
    target_id:   row.peer_id,
    target_name: row.peer_name,
    abs_r:       clampR(row.abs_r),
    r:           row.r,
    k_effects:   row.k_effects,
    k_samples:   row.k_samples,
    source:      row.source,
  }));
}

/**
 * All correlations between two constructs (in either direction).
 */
function getCorrelationBetween(idA, idB) {
  const rows = db().prepare(`
    SELECT * FROM correlations
    WHERE (search_id = ? AND target_id = ?)
       OR (search_id = ? AND target_id = ?)
    ORDER BY abs_r DESC
  `).all(idA, idB, idB, idA);
  return rows.map(row => ({ ...row, abs_r: clampR(row.abs_r) }));
}

/**
 * Get a construct's stats (pre-aggregated).
 */
function getConstructStats(constructId) {
  const stat = db().prepare('SELECT * FROM construct_stats WHERE construct_id = ?').get(constructId);
  if (!stat) return null;
  return {
    ...stat,
    avg_abs_r_out: clampR(stat.avg_abs_r_out),
    avg_abs_r_in:  clampR(stat.avg_abs_r_in),
    max_abs_r_out: clampR(stat.max_abs_r_out),
    max_abs_r_in:  clampR(stat.max_abs_r_in),
    top_correlated_ids: JSON.parse(stat.top_correlated_ids || '[]'),
  };
}

// ─────────────────────────────────────────────────────────────
// Survey branching logic
// ─────────────────────────────────────────────────────────────

/**
 * Given a score on a construct, return the next constructs to explore.
 *
 * Branching rules based on MetaBUS correlation strength:
 *   strong  (abs_r >= 0.30) → branch to all top correlates
 *   moderate (abs_r 0.15–0.29) → branch to top-3 correlates
 *   weak    (abs_r < 0.15) → branch to only the single strongest correlate
 *
 * @param {number} constructId  – the construct just scored
 * @param {number} score        – normalised score 0..1 (from survey response)
 * @param {Set}    visited      – construct ids already covered
 */
function getNextConstructs(constructId, score, visited = new Set()) {
  const correlates = getTopCorrelates(constructId, { limit: 10, minKEffects: 3 });
  const unseen = correlates.filter(c => !visited.has(c.target_id) && c.target_id !== constructId);

  const strong   = unseen.filter(c => c.abs_r >= 0.30);
  const moderate = unseen.filter(c => c.abs_r >= 0.15 && c.abs_r < 0.30);

  // Higher respondent score → explore more of the correlated space
  const intensity = score; // 0..1

  let next = [];
  if (strong.length > 0) {
    const take = Math.max(1, Math.round(intensity * strong.length));
    next = strong.slice(0, take);
  } else if (moderate.length > 0) {
    const take = Math.max(1, Math.round(intensity * Math.min(3, moderate.length)));
    next = moderate.slice(0, take);
  } else if (unseen.length > 0) {
    next = [unseen[0]];
  }

  return next;
}

/**
 * Benchmark a construct score against research norms.
 * Uses the avg_abs_r for the construct as a proxy for "how central" it is
 * in the OB literature, then interprets raw survey scores.
 *
 * @param {number} constructId
 * @param {number} score – raw 1..5 Likert mean
 * @returns {{ percentile, label, norm_avg_r, interpretation }}
 */
function benchmarkScore(constructId, score) {
  const stats = getConstructStats(constructId);
  const norm = stats ? clampR(stats.avg_abs_r_out) : 0.2;

  // Simple percentile: assume normal distribution with mean=3, sd=0.8 for survey scores
  const mean = 3, sd = 0.8;
  const z = (score - mean) / sd;
  const percentile = Math.round(100 * (0.5 * (1 + erf(z / Math.SQRT2))));

  let label, interpretation;
  if (percentile >= 75) {
    label = 'High'; interpretation = 'Well above average — potential strength';
  } else if (percentile >= 50) {
    label = 'Moderate-High'; interpretation = 'Slightly above average';
  } else if (percentile >= 25) {
    label = 'Moderate-Low'; interpretation = 'Below average — monitor';
  } else {
    label = 'Low'; interpretation = 'Well below average — priority area';
  }

  return { percentile, label, norm_avg_r: norm, interpretation };
}

// Approximation of the error function (used by benchmarkScore)
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
// Org health / summary helpers
// ─────────────────────────────────────────────────────────────

/**
 * For a map of { constructId → score }, compute overall org health metrics.
 * Returns domain scores (grouped by depth-1 ancestor) and a composite index.
 */
function computeOrgHealth(scores) {
  // scores: Map<number, { construct_name, raw_score, benchmark }>
  const domains = {};
  let total = 0, count = 0;

  for (const [constructId, entry] of scores) {
    const construct = getConstruct(constructId);
    if (!construct) continue;

    // Walk up to find depth-1 ancestor
    let domain = 'Other';
    if (construct.path) {
      domain = construct.path.split(' > ')[0] || 'Other';
    }

    if (!domains[domain]) domains[domain] = { scores: [], constructs: [] };
    domains[domain].scores.push(entry.raw_score);
    domains[domain].constructs.push({ id: constructId, name: construct.name, score: entry.raw_score });
    total += entry.raw_score;
    count++;
  }

  const domainSummaries = Object.entries(domains).map(([name, data]) => ({
    domain: name,
    avg_score: data.scores.reduce((a, b) => a + b, 0) / data.scores.length,
    construct_count: data.constructs.length,
    constructs: data.constructs.sort((a, b) => a.score - b.score), // lowest first = priorities
  }));

  return {
    overall_avg: count > 0 ? total / count : null,
    domain_summaries: domainSummaries.sort((a, b) => a.avg_score - b.avg_score),
    total_constructs_assessed: count,
  };
}

/**
 * Return knowledge base metadata.
 */
function getKBInfo() {
  const d = db();
  return {
    constructs:   d.prepare('SELECT COUNT(*) AS n FROM constructs').get().n,
    correlations: d.prepare('SELECT COUNT(*) AS n FROM correlations').get().n,
    by_source:    d.prepare('SELECT source, COUNT(*) AS n FROM correlations GROUP BY source').all(),
    stats_built:  d.prepare('SELECT COUNT(*) AS n FROM construct_stats').get().n,
  };
}

module.exports = {
  getAllConstructs,
  getConstruct,
  searchConstructs,
  getTopLevelDomains,
  getChildConstructs,
  getTopCorrelates,
  getCorrelationBetween,
  getConstructStats,
  getNextConstructs,
  benchmarkScore,
  computeOrgHealth,
  getKBInfo,
};
