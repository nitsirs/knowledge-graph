/**
 * import_to_supabase.js
 * Bulk imports constructs, correlations, and construct_stats
 * from SQLite → Supabase, handling FK ordering correctly.
 *
 * Usage: node src/import_to_supabase.js
 */

'use strict';

require('dotenv').config();

const path     = require('path');
const Database = require('better-sqlite3');
const { createClient } = require('@supabase/supabase-js');

const DB_PATH = path.resolve(__dirname, '../kb/metabus_kb.db');
const BATCH   = 500; // rows per upsert call

function supabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

function bar(n, total) {
  const pct  = ((n / total) * 100).toFixed(1);
  const fill = Math.floor(pct / 5);
  return `[${'█'.repeat(fill)}${'░'.repeat(20 - fill)}] ${pct}% ${n.toLocaleString()}/${total.toLocaleString()}`;
}

async function upsert(sb, table, rows, conflict) {
  const { error } = await sb.from(table).upsert(rows, { onConflict: conflict });
  if (error) throw new Error(`${table}: ${error.message}`);
}

async function importConstructs(sb, db) {
  console.log('\n1. Importing constructs...');

  // Load ordered by depth (nulls first, then shallow→deep) so parent always exists before child
  const rows = db.prepare(`
    SELECT id, name, parent_id, depth, path, budget
    FROM constructs
    ORDER BY CASE WHEN depth IS NULL THEN 0 ELSE depth END ASC, id ASC
  `).all();

  const total = rows.length;
  let done = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    await upsert(sb, 'constructs', batch, 'id');
    done += batch.length;
    process.stdout.write(`\r   ${bar(done, total)}`);
  }
  console.log(`\n   ✓ ${total.toLocaleString()} constructs imported`);
}

async function importCorrelations(sb, db) {
  console.log('\n2. Importing correlations (222K rows — takes ~2 min)...');

  const rows = db.prepare(`
    SELECT search_id, search_name, target_id, target_name,
           k_effects, k_samples, k_articles,
           ROUND(CAST(MIN(abs_r, 1.0) AS REAL), 6) AS abs_r,
           ROUND(CAST(r AS REAL), 6) AS r,
           source
    FROM correlations
    ORDER BY id
  `).all();

  const total = rows.length;
  let done = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    await upsert(sb, 'correlations', batch, 'search_id,target_id,source');
    done += batch.length;
    process.stdout.write(`\r   ${bar(done, total)}`);
  }
  console.log(`\n   ✓ ${total.toLocaleString()} correlations imported`);
}

async function importStats(sb, db) {
  console.log('\n3. Importing construct_stats...');

  const rows = db.prepare(`
    SELECT construct_id, construct_name,
           n_outgoing, n_incoming,
           ROUND(CAST(MIN(avg_abs_r_out, 1.0) AS REAL), 6) AS avg_abs_r_out,
           ROUND(CAST(MIN(avg_abs_r_in,  1.0) AS REAL), 6) AS avg_abs_r_in,
           ROUND(CAST(MIN(max_abs_r_out, 1.0) AS REAL), 6) AS max_abs_r_out,
           ROUND(CAST(MIN(max_abs_r_in,  1.0) AS REAL), 6) AS max_abs_r_in,
           total_k_effects,
           top_correlated_ids
    FROM construct_stats
    ORDER BY construct_id
  `).all();

  const total = rows.length;
  let done = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH).map(r => ({
      ...r,
      top_correlated_ids: JSON.parse(r.top_correlated_ids || '[]'),
    }));
    await upsert(sb, 'construct_stats', batch, 'construct_id');
    done += batch.length;
    process.stdout.write(`\r   ${bar(done, total)}`);
  }
  console.log(`\n   ✓ ${total.toLocaleString()} stats imported`);
}

async function verify(sb) {
  console.log('\n4. Verifying...');
  const tables = ['constructs', 'correlations', 'construct_stats'];
  for (const t of tables) {
    const { count } = await sb.from(t).select('*', { count: 'exact', head: true });
    console.log(`   ${t}: ${(count || 0).toLocaleString()} rows`);
  }
}

async function main() {
  const missing = [];
  if (!process.env.SUPABASE_URL)         missing.push('SUPABASE_URL');
  if (!process.env.SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_KEY');
  if (missing.length) {
    console.error('Missing .env vars:', missing.join(', '));
    process.exit(1);
  }

  console.log('MetaBUS → Supabase import\n');
  const sb = supabase();
  const db = new Database(DB_PATH, { readonly: true });

  try {
    await importConstructs(sb, db);
    await importCorrelations(sb, db);
    await importStats(sb, db);
    await verify(sb);
    console.log('\nDone! Next: node src/embed_constructs.js\n');
  } catch (err) {
    console.error('\nFatal:', err.message);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
