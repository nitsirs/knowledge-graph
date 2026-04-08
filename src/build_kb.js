/**
 * build_kb.js
 * Merges MetaBUS OB and L56 correlation CSVs + taxonomy into a SQLite knowledge base.
 *
 * Output: kb/metabus_kb.db
 * Tables:
 *   constructs    – id, name, parent_id, depth, path, budget
 *   correlations  – search_id, search_name, target_id, target_name,
 *                   k_effects, k_samples, k_articles, abs_r, r, source
 *   construct_stats – per-construct aggregated correlation stats
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT   = path.resolve(__dirname, '..');
const DATA   = path.join(ROOT, 'data');
const KB_DIR = path.join(ROOT, 'kb');
const DB_PATH = path.join(KB_DIR, 'metabus_kb.db');

// ── helpers ──────────────────────────────────────────────────────────────────

/** Parse a CSV string into array of objects (handles quoted fields). */
function parseCSV(text) {
  const lines = text.split(/\r?\n/);
  const headers = splitLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const vals = splitLine(line);
    const row = {};
    headers.forEach((h, idx) => { row[h] = vals[idx] ?? ''; });
    rows.push(row);
  }
  return rows;
}

/** Split a CSV line respecting double-quoted fields. */
function splitLine(line) {
  const result = [];
  let current = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuote = !inQuote; }
    } else if (ch === ',' && !inQuote) {
      result.push(current); current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

/** Parse "Name|12345" → { name, id }. Returns null if no pipe. */
function parseCell(cell) {
  const trimmed = cell.trim();
  const pipeIdx = trimmed.lastIndexOf('|');
  if (pipeIdx === -1) return null;
  return {
    name: trimmed.slice(0, pipeIdx).trim(),
    id: parseInt(trimmed.slice(pipeIdx + 1).trim(), 10),
  };
}

// ── taxonomy parser ───────────────────────────────────────────────────────────

function parseTaxonomy(rows) {
  const constructs = new Map(); // id → { id, name, parent_id, depth, path, budget }

  for (const row of rows) {
    // Find the deepest non-empty level column
    let depth = -1;
    let lastCell = null;
    for (let lvl = 0; lvl <= 12; lvl++) {
      const val = row[`level${lvl}`];
      if (val && val.trim()) { depth = lvl; lastCell = val; }
    }
    if (depth < 1 || !lastCell) continue; // skip header-level row (level0 = "OB/HR Variables")

    const parsed = parseCell(lastCell);
    if (!parsed || isNaN(parsed.id)) continue;

    // Build path array and find parent
    const pathParts = [];
    let parentId = null;
    for (let lvl = 1; lvl <= depth; lvl++) {
      const cellVal = row[`level${lvl}`];
      if (!cellVal || !cellVal.trim()) break;
      const p = parseCell(cellVal);
      if (!p) break;
      pathParts.push(p.name);
      if (lvl === depth - 1) parentId = p.id;
    }

    const budget = parseInt(row['cur_budget'] || '0', 10);

    if (!constructs.has(parsed.id)) {
      constructs.set(parsed.id, {
        id: parsed.id,
        name: parsed.name,
        parent_id: parentId,
        depth: depth,
        path: pathParts.join(' > '),
        budget: isNaN(budget) ? 0 : budget,
      });
    }
  }
  return constructs;
}

// ── correlation parser ────────────────────────────────────────────────────────

function parseCorrelations(rows, source) {
  const out = [];
  for (const row of rows) {
    const searchId  = parseInt(row['search_id'],  10);
    const targetId  = parseInt(row['target_id'],  10);
    const kEffects  = parseInt(row['k_effects'],  10);
    const kSamples  = parseInt(row['k_samples'],  10);
    const kArticles = parseInt(row['k_articles'], 10);
    const absR      = parseFloat(row['abs_r']);
    const r         = parseFloat(row['r']);

    if (isNaN(searchId) || isNaN(targetId)) continue;

    out.push({
      search_id:   searchId,
      search_name: (row['search_name'] || '').trim(),
      target_id:   targetId,
      target_name: (row['target_name'] || '').trim(),
      k_effects:   isNaN(kEffects)  ? 0 : kEffects,
      k_samples:   isNaN(kSamples)  ? 0 : kSamples,
      k_articles:  isNaN(kArticles) ? 0 : kArticles,
      abs_r:       isNaN(absR) ? 0 : absR,
      r:           isNaN(r)    ? 0 : r,
      source,
    });
  }
  return out;
}

// ── build database ────────────────────────────────────────────────────────────

function buildDatabase(constructs, allCorrelations) {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  const db = new Database(DB_PATH);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous  = NORMAL;

    CREATE TABLE constructs (
      id        INTEGER PRIMARY KEY,
      name      TEXT    NOT NULL,
      parent_id INTEGER,
      depth     INTEGER,
      path      TEXT,
      budget    INTEGER DEFAULT 0,
      FOREIGN KEY (parent_id) REFERENCES constructs(id)
    );

    CREATE TABLE correlations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      search_id   INTEGER NOT NULL,
      search_name TEXT,
      target_id   INTEGER NOT NULL,
      target_name TEXT,
      k_effects   INTEGER,
      k_samples   INTEGER,
      k_articles  INTEGER,
      abs_r       REAL,
      r           REAL,
      source      TEXT,
      UNIQUE (search_id, target_id, source)
    );

    CREATE TABLE construct_stats (
      construct_id       INTEGER PRIMARY KEY,
      construct_name     TEXT,
      n_outgoing         INTEGER,
      n_incoming         INTEGER,
      avg_abs_r_out      REAL,
      avg_abs_r_in       REAL,
      max_abs_r_out      REAL,
      max_abs_r_in       REAL,
      total_k_effects    INTEGER,
      top_correlated_ids TEXT
    );

    CREATE INDEX idx_corr_search ON correlations(search_id);
    CREATE INDEX idx_corr_target ON correlations(target_id);
    CREATE INDEX idx_corr_abs_r  ON correlations(abs_r DESC);
  `);

  // Insert constructs
  const insertConstruct = db.prepare(`
    INSERT OR REPLACE INTO constructs (id, name, parent_id, depth, path, budget)
    VALUES (@id, @name, @parent_id, @depth, @path, @budget)
  `);
  const insertManyConstructs = db.transaction((rows) => {
    for (const row of rows) insertConstruct.run(row);
  });
  insertManyConstructs([...constructs.values()]);
  console.log(`  Inserted ${constructs.size} constructs`);

  // Insert correlations in batches
  const insertCorr = db.prepare(`
    INSERT OR IGNORE INTO correlations
      (search_id, search_name, target_id, target_name, k_effects, k_samples, k_articles, abs_r, r, source)
    VALUES
      (@search_id, @search_name, @target_id, @target_name, @k_effects, @k_samples, @k_articles, @abs_r, @r, @source)
  `);
  const BATCH = 5000;
  let inserted = 0;
  for (let i = 0; i < allCorrelations.length; i += BATCH) {
    const batch = allCorrelations.slice(i, i + BATCH);
    db.transaction((rows) => { for (const r of rows) insertCorr.run(r); })(batch);
    inserted += batch.length;
    process.stdout.write(`\r  Correlations inserted: ${inserted.toLocaleString()} / ${allCorrelations.length.toLocaleString()}`);
  }
  console.log();

  // Build construct_stats
  console.log('  Computing construct stats...');
  db.exec(`
    INSERT INTO construct_stats
      (construct_id, construct_name, n_outgoing, n_incoming,
       avg_abs_r_out, avg_abs_r_in, max_abs_r_out, max_abs_r_in, total_k_effects)
    SELECT
      c.id,
      c.name,
      COALESCE(out.n, 0)        AS n_outgoing,
      COALESCE(inn.n, 0)        AS n_incoming,
      COALESCE(out.avg_r, 0)    AS avg_abs_r_out,
      COALESCE(inn.avg_r, 0)    AS avg_abs_r_in,
      COALESCE(out.max_r, 0)    AS max_abs_r_out,
      COALESCE(inn.max_r, 0)    AS max_abs_r_in,
      COALESCE(out.tot_k, 0) + COALESCE(inn.tot_k, 0) AS total_k_effects
    FROM constructs c
    LEFT JOIN (
      SELECT search_id AS cid,
             COUNT(*)  AS n,
             AVG(abs_r) AS avg_r,
             MAX(abs_r) AS max_r,
             SUM(k_effects) AS tot_k
      FROM correlations GROUP BY search_id
    ) out ON out.cid = c.id
    LEFT JOIN (
      SELECT target_id AS cid,
             COUNT(*)  AS n,
             AVG(abs_r) AS avg_r,
             MAX(abs_r) AS max_r,
             SUM(k_effects) AS tot_k
      FROM correlations GROUP BY target_id
    ) inn ON inn.cid = c.id
    WHERE out.n IS NOT NULL OR inn.n IS NOT NULL
  `);

  // Store top-5 correlated construct IDs per construct (JSON array)
  const topPairs = db.prepare(`
    SELECT target_id, abs_r FROM correlations
    WHERE search_id = ? ORDER BY abs_r DESC LIMIT 5
  `);
  const updateTop = db.prepare(`
    UPDATE construct_stats SET top_correlated_ids = ? WHERE construct_id = ?
  `);
  const statIds = db.prepare('SELECT construct_id FROM construct_stats').all();
  db.transaction(() => {
    for (const { construct_id } of statIds) {
      const top = topPairs.all(construct_id).map(r => r.target_id);
      updateTop.run(JSON.stringify(top), construct_id);
    }
  })();

  const counts = db.prepare('SELECT COUNT(*) AS n FROM construct_stats').get();
  console.log(`  Stats built for ${counts.n} constructs`);

  db.close();
}

// ── summary report ────────────────────────────────────────────────────────────

function printSummary() {
  const db = new Database(DB_PATH, { readonly: true });

  const totalConstructs   = db.prepare('SELECT COUNT(*) AS n FROM constructs').get().n;
  const totalCorrelations = db.prepare('SELECT COUNT(*) AS n FROM correlations').get().n;
  const bySource          = db.prepare('SELECT source, COUNT(*) AS n FROM correlations GROUP BY source').all();
  const topPairs          = db.prepare(`
    SELECT search_name, target_name, abs_r, k_effects, source
    FROM correlations ORDER BY abs_r DESC LIMIT 10
  `).all();

  console.log('\n══════════════════════════════════════════════════');
  console.log('  MetaBUS Knowledge Base — Build Summary');
  console.log('══════════════════════════════════════════════════');
  console.log(`  Constructs:     ${totalConstructs.toLocaleString()}`);
  console.log(`  Correlations:   ${totalCorrelations.toLocaleString()}`);
  bySource.forEach(r => console.log(`    [${r.source}]  ${r.n.toLocaleString()}`));
  console.log('\n  Top 10 strongest correlations:');
  topPairs.forEach((p, i) => {
    console.log(`  ${String(i+1).padStart(2)}. |r|=${p.abs_r.toFixed(3)}  k=${p.k_effects}  [${p.source}]`);
    console.log(`      "${p.search_name}" ↔ "${p.target_name}"`);
  });
  console.log('══════════════════════════════════════════════════\n');
  console.log(`  DB saved to: ${DB_PATH}`);

  db.close();
}

// ── main ──────────────────────────────────────────────────────────────────────

(function main() {
  console.log('Building MetaBUS knowledge base...\n');

  // 1. Parse taxonomy
  console.log('1. Parsing construct taxonomy (metabus.csv)...');
  const taxRows = parseCSV(fs.readFileSync(path.join(DATA, 'metabus.csv'), 'utf8'));
  const constructs = parseTaxonomy(taxRows);
  console.log(`   Found ${constructs.size} constructs`);

  // 2. Parse correlations from both sources
  console.log('2. Loading OB correlations...');
  const obRows   = parseCSV(fs.readFileSync(path.join(DATA, 'metabus_OB_correlations_FULL.csv'),  'utf8'));
  const obCorr   = parseCorrelations(obRows, 'OB');
  console.log(`   ${obCorr.length.toLocaleString()} valid rows`);

  console.log('3. Loading L56 correlations...');
  const l56Rows  = parseCSV(fs.readFileSync(path.join(DATA, 'metabus_L56_correlations_FULL.csv'), 'utf8'));
  const l56Corr  = parseCorrelations(l56Rows, 'L56');
  console.log(`   ${l56Corr.length.toLocaleString()} valid rows`);

  // 3. Enrich constructs from correlation data (captures constructs not in taxonomy)
  const allCorrelations = [...obCorr, ...l56Corr];
  for (const corr of allCorrelations) {
    if (!constructs.has(corr.search_id)) {
      constructs.set(corr.search_id, {
        id: corr.search_id, name: corr.search_name,
        parent_id: null, depth: null, path: null, budget: 0,
      });
    }
    if (!constructs.has(corr.target_id)) {
      constructs.set(corr.target_id, {
        id: corr.target_id, name: corr.target_name,
        parent_id: null, depth: null, path: null, budget: 0,
      });
    }
  }
  console.log(`   Total unique constructs (incl. from correlations): ${constructs.size}`);

  // 4. Build database
  console.log('4. Writing SQLite database...');
  buildDatabase(constructs, allCorrelations);

  // 5. Summary
  printSummary();
})();
