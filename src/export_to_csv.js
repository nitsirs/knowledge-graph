/**
 * export_to_csv.js
 *
 * Exports SQLite KB tables to CSVs ready for Supabase bulk import.
 * Use Supabase Dashboard → Table Editor → Import CSV, or psql \COPY.
 *
 * Output:
 *   exports/constructs.csv
 *   exports/correlations.csv
 *   exports/construct_stats.csv
 *
 * Usage:
 *   node src/export_to_csv.js
 */

'use strict';

const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');

const DB_PATH    = path.resolve(__dirname, '../kb/metabus_kb.db');
const EXPORT_DIR = path.resolve(__dirname, '../exports');

function escapeCSV(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function writeCSV(filePath, columns, rows, transform = r => r) {
  const out = fs.createWriteStream(filePath);
  out.write(columns.join(',') + '\n');
  let count = 0;
  for (const row of rows) {
    const r = transform(row);
    out.write(columns.map(c => escapeCSV(r[c])).join(',') + '\n');
    count++;
    if (count % 10000 === 0) process.stdout.write(`\r  ${count.toLocaleString()} rows...`);
  }
  out.end();
  return count;
}

function main() {
  if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });

  const db = new Database(DB_PATH, { readonly: true });

  // ── constructs (no embedding column — embeddings added by embed_constructs.js)
  console.log('Exporting constructs...');
  const constructs = db.prepare(
    'SELECT id, name, parent_id, depth, path, budget FROM constructs ORDER BY id'
  ).all();
  const cCount = writeCSV(
    path.join(EXPORT_DIR, 'constructs.csv'),
    ['id', 'name', 'parent_id', 'depth', 'path', 'budget'],
    constructs
  );
  console.log(`\n  ${cCount.toLocaleString()} constructs → exports/constructs.csv`);

  // ── correlations
  console.log('Exporting correlations...');
  const corrs = db.prepare(
    `SELECT search_id, search_name, target_id, target_name,
            k_effects, k_samples, k_articles, abs_r, r, source
     FROM correlations ORDER BY id`
  ).all();
  const rCount = writeCSV(
    path.join(EXPORT_DIR, 'correlations.csv'),
    ['search_id','search_name','target_id','target_name',
     'k_effects','k_samples','k_articles','abs_r','r','source'],
    corrs,
    row => ({
      ...row,
      // clamp abs_r to [0,1] on export
      abs_r: Math.min(1, Math.max(0, row.abs_r)),
    })
  );
  console.log(`\n  ${rCount.toLocaleString()} correlations → exports/correlations.csv`);

  // ── construct_stats
  console.log('Exporting construct_stats...');
  const stats = db.prepare('SELECT * FROM construct_stats ORDER BY construct_id').all();
  const sCount = writeCSV(
    path.join(EXPORT_DIR, 'construct_stats.csv'),
    ['construct_id','construct_name','n_outgoing','n_incoming',
     'avg_abs_r_out','avg_abs_r_in','max_abs_r_out','max_abs_r_in',
     'total_k_effects','top_correlated_ids'],
    stats
  );
  console.log(`\n  ${sCount.toLocaleString()} stats → exports/construct_stats.csv`);

  db.close();

  console.log('\nExport complete. Files in exports/');
  console.log('\nImport order into Supabase:');
  console.log('  1. constructs.csv      (no FK deps)');
  console.log('  2. correlations.csv    (depends on constructs)');
  console.log('  3. construct_stats.csv (depends on constructs)');
  console.log('\nThen run: node src/embed_constructs.js');
}

main();
