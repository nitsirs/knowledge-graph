-- ============================================================
-- MetaBUS Knowledge Base — Supabase Migration
-- Run this in: Supabase Dashboard → SQL Editor
-- ============================================================

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- ────────────────────────────────────────────────────────────
-- Table: constructs
-- Stores all OB/HR constructs with taxonomy hierarchy
-- and pgvector embedding for semantic search
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS constructs (
  id         INTEGER      PRIMARY KEY,
  name       TEXT         NOT NULL,
  parent_id  INTEGER      REFERENCES constructs(id),
  depth      INTEGER,
  path       TEXT,                          -- e.g. "Attitudes > Work attitudes"
  budget     INTEGER      DEFAULT 0,        -- MetaBUS research budget (proxy for depth)
  embedding  vector(1536)                   -- OpenAI text-embedding-3-small
);

CREATE INDEX IF NOT EXISTS idx_constructs_parent  ON constructs(parent_id);
CREATE INDEX IF NOT EXISTS idx_constructs_depth   ON constructs(depth);
CREATE INDEX IF NOT EXISTS idx_constructs_budget  ON constructs(budget DESC);

-- IVFFlat index for fast approximate nearest-neighbour search
-- Create AFTER embeddings are loaded (run separately after embed_constructs.js)
-- CREATE INDEX constructs_embedding_idx
--   ON constructs USING ivfflat (embedding vector_cosine_ops)
--   WITH (lists = 100);

-- ────────────────────────────────────────────────────────────
-- Table: correlations
-- Meta-analytic correlations between construct pairs
-- source: 'OB' = OB/HR dataset, 'L56' = Levels 5-6 dataset
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS correlations (
  id          BIGSERIAL    PRIMARY KEY,
  search_id   INTEGER      NOT NULL REFERENCES constructs(id),
  search_name TEXT,
  target_id   INTEGER      NOT NULL REFERENCES constructs(id),
  target_name TEXT,
  k_effects   INTEGER,                      -- number of effect sizes pooled
  k_samples   INTEGER,
  k_articles  INTEGER,
  abs_r       NUMERIC(8,6),                 -- absolute correlation [0, 1]
  r           NUMERIC(8,6),                 -- signed correlation
  source      TEXT,                         -- 'OB' or 'L56'
  UNIQUE (search_id, target_id, source)
);

CREATE INDEX IF NOT EXISTS idx_corr_search    ON correlations(search_id);
CREATE INDEX IF NOT EXISTS idx_corr_target    ON correlations(target_id);
CREATE INDEX IF NOT EXISTS idx_corr_abs_r     ON correlations(abs_r DESC);
CREATE INDEX IF NOT EXISTS idx_corr_source    ON correlations(source);

-- ────────────────────────────────────────────────────────────
-- Table: construct_stats
-- Pre-aggregated per-construct stats for fast benchmarking
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS construct_stats (
  construct_id       INTEGER      PRIMARY KEY REFERENCES constructs(id),
  construct_name     TEXT,
  n_outgoing         INTEGER      DEFAULT 0,
  n_incoming         INTEGER      DEFAULT 0,
  avg_abs_r_out      NUMERIC(8,6) DEFAULT 0,
  avg_abs_r_in       NUMERIC(8,6) DEFAULT 0,
  max_abs_r_out      NUMERIC(8,6) DEFAULT 0,
  max_abs_r_in       NUMERIC(8,6) DEFAULT 0,
  total_k_effects    INTEGER      DEFAULT 0,
  top_correlated_ids JSONB        DEFAULT '[]'  -- array of top peer construct IDs
);

-- ────────────────────────────────────────────────────────────
-- Function: match_constructs
-- Semantic similarity search using pgvector cosine distance
-- Called by kb_supabase.js → searchConstructSemantic()
--
-- Usage:
--   SELECT * FROM match_constructs(embedding, 0.5, 10);
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION match_constructs (
  query_embedding vector(1536),
  match_threshold FLOAT   DEFAULT 0.5,
  match_count     INTEGER DEFAULT 10
)
RETURNS TABLE (
  id         INTEGER,
  name       TEXT,
  path       TEXT,
  depth      INTEGER,
  budget     INTEGER,
  similarity FLOAT
)
LANGUAGE SQL STABLE
AS $$
  SELECT
    c.id,
    c.name,
    c.path,
    c.depth,
    c.budget,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM constructs c
  WHERE c.embedding IS NOT NULL
    AND 1 - (c.embedding <=> query_embedding) > match_threshold
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ────────────────────────────────────────────────────────────
-- Function: get_top_correlates
-- Bidirectional correlate lookup (outgoing + incoming)
-- Called by kb_supabase.js → getTopCorrelates()
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_top_correlates (
  p_construct_id INTEGER,
  p_min_k        INTEGER DEFAULT 3,
  p_limit        INTEGER DEFAULT 10,
  p_source       TEXT    DEFAULT NULL
)
RETURNS TABLE (
  target_id   INTEGER,
  target_name TEXT,
  abs_r       NUMERIC,
  r           NUMERIC,
  k_effects   INTEGER,
  source      TEXT
)
LANGUAGE SQL STABLE
AS $$
  SELECT
    peer_id,
    peer_name,
    MAX(abs_r)       AS abs_r,
    MAX(r)           AS r,
    MAX(k_effects)   AS k_effects,
    MIN(source)      AS source
  FROM (
    SELECT
      target_id   AS peer_id,
      target_name AS peer_name,
      LEAST(abs_r, 1.0) AS abs_r,
      r,
      k_effects,
      source
    FROM correlations
    WHERE search_id  = p_construct_id
      AND target_id != p_construct_id
      AND abs_r      BETWEEN 0.001 AND 1.0
      AND k_effects >= p_min_k
      AND (p_source IS NULL OR source = p_source)

    UNION ALL

    SELECT
      search_id   AS peer_id,
      search_name AS peer_name,
      LEAST(abs_r, 1.0) AS abs_r,
      r,
      k_effects,
      source
    FROM correlations
    WHERE target_id  = p_construct_id
      AND search_id != p_construct_id
      AND abs_r      BETWEEN 0.001 AND 1.0
      AND k_effects >= p_min_k
      AND (p_source IS NULL OR source = p_source)
  ) sub
  GROUP BY peer_id, peer_name
  ORDER BY abs_r DESC
  LIMIT p_limit;
$$;
