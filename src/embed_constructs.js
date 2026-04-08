/**
 * embed_constructs.js
 *
 * Generates OpenAI embeddings for all constructs in the local SQLite KB
 * and upserts them into Supabase (constructs.embedding column).
 *
 * Run once after migration.sql has been applied in Supabase.
 *
 * Usage:
 *   node src/embed_constructs.js
 *
 * Requires .env:
 *   OPENAI_API_KEY=sk-...
 *   SUPABASE_URL=https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY=eyJ...   (use service role key, not anon)
 */

'use strict';

require('dotenv').config();

const path       = require('path');
const Database   = require('better-sqlite3');
const { createClient } = require('@supabase/supabase-js');
const OpenAI     = require('openai');

// ── config ────────────────────────────────────────────────────────────────────

const DB_PATH        = path.resolve(__dirname, '../kb/metabus_kb.db');
const EMBEDDING_MODEL = 'text-embedding-3-small'; // 1536 dims, cheap
const BATCH_SIZE      = 100;   // OpenAI allows up to 2048 texts per request
const UPSERT_BATCH    = 50;    // Supabase upsert batch size

// ── clients ───────────────────────────────────────────────────────────────────

function getClients() {
  const missing = [];
  if (!process.env.OPENAI_API_KEY)       missing.push('OPENAI_API_KEY');
  if (!process.env.SUPABASE_URL)         missing.push('SUPABASE_URL');
  if (!process.env.SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_KEY');
  if (missing.length) {
    console.error('Missing environment variables:', missing.join(', '));
    console.error('Create a .env file in the project root. See .env.example');
    process.exit(1);
  }

  const openai   = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
  return { openai, supabase };
}

// ── embedding text builder ────────────────────────────────────────────────────

/**
 * Build a rich text representation of a construct for embedding.
 * Including the taxonomy path gives better semantic placement than name alone.
 *
 * e.g. "Job satisfaction — Attitudes / evaluations > Work attitudes > Job satisfaction"
 */
function buildEmbedText(construct) {
  const parts = [construct.name];
  if (construct.path && construct.path !== construct.name) {
    parts.push(construct.path);
  }
  return parts.join(' — ');
}

// ── embed batch ───────────────────────────────────────────────────────────────

async function embedBatch(openai, texts) {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });
  // response.data is ordered same as input
  return response.data.map(d => d.embedding);
}

// ── upsert to Supabase ────────────────────────────────────────────────────────

async function upsertConstructs(supabase, rows) {
  // rows: [{ id, name, parent_id, depth, path, budget, embedding }]
  const { error } = await supabase
    .from('constructs')
    .upsert(rows, { onConflict: 'id' });

  if (error) throw new Error(`Supabase upsert error: ${error.message}`);
}

// ── progress helpers ──────────────────────────────────────────────────────────

function progress(current, total, label = '') {
  const pct = ((current / total) * 100).toFixed(1);
  const bar = '█'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5));
  process.stdout.write(`\r  [${bar}] ${pct}%  ${current}/${total}  ${label}    `);
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('MetaBUS — Construct Embedding Pipeline\n');

  const { openai, supabase } = getClients();

  // 1. Load all constructs from SQLite
  console.log('1. Loading constructs from local KB...');
  const localDb = new Database(DB_PATH, { readonly: true });
  const constructs = localDb.prepare(
    'SELECT id, name, parent_id, depth, path, budget FROM constructs ORDER BY id'
  ).all();
  localDb.close();
  console.log(`   ${constructs.length.toLocaleString()} constructs loaded`);

  // 2. Check which are already embedded in Supabase (resume support)
  console.log('2. Checking existing embeddings in Supabase...');
  const { data: existing, error: fetchErr } = await supabase
    .from('constructs')
    .select('id')
    .not('embedding', 'is', null);

  if (fetchErr) throw new Error(`Supabase fetch error: ${fetchErr.message}`);

  const embeddedIds = new Set((existing || []).map(r => r.id));
  const todo = constructs.filter(c => !embeddedIds.has(c.id));
  console.log(`   Already embedded: ${embeddedIds.size.toLocaleString()}`);
  console.log(`   Remaining:        ${todo.length.toLocaleString()}`);

  if (todo.length === 0) {
    console.log('\nAll constructs already embedded. Nothing to do.');
    await createVectorIndex(supabase);
    return;
  }

  // 3. Embed in batches
  console.log(`\n3. Generating embeddings (model: ${EMBEDDING_MODEL})...`);
  const embedded = []; // [{ id, name, ..., embedding }]

  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const batch = todo.slice(i, i + BATCH_SIZE);
    const texts  = batch.map(buildEmbedText);

    try {
      const vectors = await embedBatch(openai, texts);
      batch.forEach((c, idx) => {
        embedded.push({
          id:        c.id,
          name:      c.name,
          parent_id: c.parent_id,
          depth:     c.depth,
          path:      c.path,
          budget:    c.budget,
          embedding: vectors[idx],
        });
      });
    } catch (err) {
      console.error(`\n  Embedding error at batch ${i}-${i + BATCH_SIZE}:`, err.message);
      console.error('  Retrying in 5s...');
      await new Promise(r => setTimeout(r, 5000));
      i -= BATCH_SIZE; // retry same batch
      continue;
    }

    progress(Math.min(i + BATCH_SIZE, todo.length), todo.length, batch[0].name.slice(0, 30));

    // Upsert when we have enough accumulated or at the end
    if (embedded.length >= UPSERT_BATCH || i + BATCH_SIZE >= todo.length) {
      try {
        await upsertConstructs(supabase, embedded.splice(0));
      } catch (err) {
        console.error('\n  Supabase upsert error:', err.message);
        process.exit(1);
      }
    }
  }

  console.log(`\n\n4. Embedding complete. Creating vector index...`);
  await createVectorIndex(supabase);

  console.log('\nDone! All constructs embedded and indexed.');
  console.log('You can now use searchConstructSemantic() in kb_supabase.js\n');
}

// ── create IVFFlat index ──────────────────────────────────────────────────────

async function createVectorIndex(supabase) {
  // IVFFlat requires knowing approximate row count for `lists` parameter
  // Rule of thumb: lists ≈ sqrt(rows), min 1
  const { count } = await supabase
    .from('constructs')
    .select('*', { count: 'exact', head: true })
    .not('embedding', 'is', null);

  const lists = Math.max(1, Math.round(Math.sqrt(count || 4870)));
  console.log(`   Creating IVFFlat index (lists=${lists}) for ${count} embedded constructs...`);

  // Must use raw SQL via rpc — Supabase JS client doesn't support DDL directly
  const { error } = await supabase.rpc('create_vector_index', { p_lists: lists });

  if (error) {
    // Index creation may fail if it already exists or if rpc not set up yet
    console.log(`   Note: Could not auto-create index (${error.message})`);
    console.log('   Run this manually in Supabase SQL editor after loading data:');
    console.log(`   CREATE INDEX constructs_embedding_idx`);
    console.log(`     ON constructs USING ivfflat (embedding vector_cosine_ops)`);
    console.log(`     WITH (lists = ${lists});`);
  } else {
    console.log('   Vector index created.');
  }
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
