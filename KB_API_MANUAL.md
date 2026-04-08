# MetaBUS Knowledge Base — API Manual

**Base URL:** `https://grgoshdgiuqihkkqlfhh.supabase.co/functions/v1/kb`

No authentication required. CORS enabled for all origins.

---

## What This API Is

A query interface over 222,123 meta-analytic correlations from the MetaBUS database,
covering 4,870 organizational behavior (OB) constructs. Every correlation is backed
by real published research (k = number of studies pooled).

Use it to:
- Find which OB construct matches a keyword or phrase
- Get a context bundle for Claude to generate a survey question
- Get the top correlated constructs for adaptive branching
- List the top-level OB domains to start a survey

---

## Endpoints

### 1. `GET /domains`

Returns the 11 top-level OB/HR domains, ordered by research depth.
Use this as the **survey starting menu**.

**Request**
```
GET /functions/v1/kb/domains
```

**Response**
```json
{
  "domains": [
    { "id": 20339, "name": "Person characteristics",       "budget": 568538 },
    { "id": 20115, "name": "Attitudes / evaluations",      "budget": 380246 },
    { "id": 20203, "name": "Behaviors",                    "budget": 266361 },
    { "id": 20521, "name": "Organizational characteristics","budget": 150892 },
    { "id": 20539, "name": "Contextual characteristics",   "budget": 38917  },
    { "id": 30109, "name": "Very miscellaneous",           "budget": 35633  },
    { "id": 20182, "name": "Intentions",                   "budget": 28722  },
    { "id": 20138, "name": "Dyad/group characteristics",   "budget": 26254  },
    { "id": 40165, "name": "HR practices",                 "budget": 20681  },
    { "id": 20537, "name": "Cognitions",                   "budget": 13368  },
    { "id": 20114, "name": "Occupational characteristics", "budget": 2196   }
  ]
}
```

**Fields**
| Field | Description |
|---|---|
| `id` | Construct ID — use this in other endpoints |
| `name` | Domain name |
| `budget` | Total MetaBUS research budget — proxy for how much research exists |

---

### 2. `POST /search`

Find constructs matching a keyword or phrase.

**Tries SQL first** (fast, exact substring). If fewer than 3 results, **falls back to semantic search** (pgvector cosine similarity via OpenAI embeddings). This means "job stress" finds "Emotional exhaustion", "Burnout", "Work strain" even though none contain the exact words.

**Request**
```
POST /functions/v1/kb/search
Content-Type: application/json
```

```json
{
  "keyword":   "burnout",
  "limit":     10,
  "threshold": 0.4
}
```

**Parameters**
| Field | Type | Default | Description |
|---|---|---|---|
| `keyword` | string | required | Search term or phrase |
| `limit` | number | 10 | Max results (max 50) |
| `threshold` | number | 0.4 | Min similarity for semantic search (0–1, higher = stricter) |

**Response**
```json
{
  "match_type": "semantic",
  "results": [
    {
      "id":         20429,
      "name":       "Burnout",
      "path":       "Person characteristics > Psychological > States > Negative > Stress > Exhaustion > Burnout",
      "depth":      7,
      "budget":     4091,
      "similarity": 0.633
    }
  ]
}
```

**Fields**
| Field | Description |
|---|---|
| `match_type` | `"sql"` = exact match found, `"semantic"` = embedding search used |
| `id` | Construct ID |
| `name` | Construct name |
| `path` | Full taxonomy path (shows hierarchy) |
| `depth` | Depth in taxonomy (1 = top domain, 8 = very specific) |
| `budget` | Research depth proxy |
| `similarity` | Cosine similarity score (only present for semantic results) |

**Examples**

| Keyword | match_type | Top result |
|---|---|---|
| `"leadership"` | sql | Leadership (id: 20201) |
| `"burnout"` | semantic | Burnout (id: 20429) |
| `"job stress"` | semantic | Job pressure, Work stressors, Job tension |
| `"employees feeling tired and disengaged"` | semantic | Daily work engagement, Fatigue, Burnout |

---

### 3. `GET /context?id=`

Returns the **full context bundle** Claude needs to generate a survey question for a construct.

This is the primary endpoint for the Claude side.

**Request**
```
GET /functions/v1/kb/context?id=20200
```

**Parameters**
| Param | Description |
|---|---|
| `id` | Construct ID (from /search or /domains) |

**Response**
```json
{
  "construct": {
    "id":     20200,
    "name":   "Transformational leadership",
    "path":   "Behaviors > As employee > Leadership > Relations behavior/style > Transformational leadership",
    "domain": "Behaviors",
    "depth":  5
  },
  "top_correlates": [
    { "name": "Charismatic leadership",   "abs_r": 0.972, "r": 0.877, "k_effects": 102, "direction": "positive" },
    { "name": "Satisfaction with leader", "abs_r": 0.925, "r": 0.925, "k_effects": 21,  "direction": "positive" },
    { "name": "Supervisor charisma",      "abs_r": 0.923, "r": 0.780, "k_effects": 62,  "direction": "positive" },
    { "name": "Change behavior/style",    "abs_r": 0.900, "r": 0.820, "k_effects": 141, "direction": "positive" },
    { "name": "Yukl's categories",        "abs_r": 0.890, "r": 0.890, "k_effects": 9,   "direction": "positive" }
  ],
  "stats": {
    "n_incoming":      269,
    "avg_abs_r_in":    0.320,
    "max_abs_r_in":    0.972,
    "total_k_effects": 44182
  },
  "evidence_strength": "strong"
}
```

**Fields**
| Field | Description |
|---|---|
| `construct.name` | Use this as the subject of the survey question |
| `construct.path` | Taxonomy path — tells Claude what domain this belongs to |
| `construct.domain` | Top-level domain (e.g. "Behaviors", "Attitudes / evaluations") |
| `top_correlates` | Top 5 empirically correlated constructs (min 5 studies) |
| `top_correlates[].abs_r` | Correlation strength 0–1 (higher = stronger relationship) |
| `top_correlates[].r` | Signed correlation (negative = inverse relationship) |
| `top_correlates[].direction` | `"positive"` or `"negative"` |
| `top_correlates[].k_effects` | Number of studies this is based on |
| `stats.total_k_effects` | Total studies across all correlations for this construct |
| `evidence_strength` | `"strong"` (≥1000 studies), `"moderate"` (≥100), `"limited"` (<100) |

**How Claude should use this**

```
You are generating a multiple-choice survey question.

Construct: {construct.name}
Domain: {construct.domain}
Taxonomy path: {construct.path}
Evidence strength: {evidence_strength} ({stats.total_k_effects} studies)

Related constructs (empirically correlated):
{top_correlates.map(c => `- ${c.name} (|r|=${c.abs_r}, ${c.direction})`)}

Generate a 5-point Likert scale question that assesses {construct.name}
in an organizational context. Keep it practical and jargon-free.
```

---

### 4. `GET /correlates?id=`

Returns the top correlated constructs for a given construct.
Use this for **adaptive branching** — deciding which construct to probe next
based on the user's answer.

**Request**
```
GET /functions/v1/kb/correlates?id=20429&limit=10&min_k=5&source=OB
```

**Parameters**
| Param | Type | Default | Description |
|---|---|---|---|
| `id` | number | required | Construct ID |
| `limit` | number | 10 | Max results (max 50) |
| `min_k` | number | 3 | Minimum studies required (higher = more reliable) |
| `source` | string | both | Filter by dataset: `OB` or `L56` |

**Response**
```json
{
  "construct_id": 20429,
  "correlates": [
    { "id": 20094, "name": "Need satisfaction", "abs_r": 0.746, "r": -0.746, "k_effects": 7,  "source": "L56", "direction": "negative" },
    { "id": 20431, "name": "Job stress",         "abs_r": 0.607, "r":  0.607, "k_effects": 11, "source": "L56", "direction": "positive" },
    { "id": 20092, "name": "Engagement",          "abs_r": 0.539, "r": -0.303, "k_effects": 65, "source": "L56", "direction": "negative" },
    { "id": 20434, "name": "Strain",              "abs_r": 0.538, "r":  0.284, "k_effects": 12, "source": "L56", "direction": "positive" }
  ]
}
```

**Adaptive branching logic (recommended)**

```js
function pickNextConstruct(correlates, score, visited) {
  const unseen = correlates.filter(c => !visited.has(c.id))

  const strong   = unseen.filter(c => c.abs_r >= 0.30)
  const moderate = unseen.filter(c => c.abs_r >= 0.15 && c.abs_r < 0.30)

  // score = normalised user answer (0–1, where 1 = strongly agree)
  if (strong.length > 0) {
    const take = Math.max(1, Math.round(score * strong.length))
    return strong.slice(0, take)
  }
  if (moderate.length > 0) {
    return moderate.slice(0, Math.max(1, Math.round(score * 3)))
  }
  return unseen.slice(0, 1)
}
```

**Correlation strength guide**

| abs_r | Strength | Interpretation |
|---|---|---|
| ≥ 0.50 | Very strong | Almost always co-occur — must probe |
| 0.30–0.49 | Strong | High priority for branching |
| 0.15–0.29 | Moderate | Probe if score is high |
| < 0.15 | Weak | Skip unless time permits |

---

## Typical Survey Flow

```
1. GET /domains
   → Show user the 11 domains, they pick one (e.g. "Attitudes / evaluations")

2. POST /search { keyword: "job satisfaction" }
   → Get construct id (e.g. 20072)

3. GET /context?id=20072
   → Send to Claude → Claude generates MCQ question

4. User answers (e.g. 2/5 = low)

5. GET /correlates?id=20072&limit=10&min_k=5
   → Pick next construct based on score + correlation strength

6. Repeat steps 3–5 for 10–20 constructs

7. Aggregate scores → org health dashboard
```

---

## Data Sources

| Source | Description | Rows |
|---|---|---|
| `OB` | MetaBUS OB/HR full dataset | 121,178 |
| `L56` | MetaBUS Levels 5–6 constructs | 100,945 |

Both datasets are merged. When the same pair appears in both, the higher abs_r is used.

---

## Quick Reference

```bash
# All 11 OB domains
curl https://grgoshdgiuqihkkqlfhh.supabase.co/functions/v1/kb/domains

# Search by keyword (SQL + semantic)
curl -X POST https://grgoshdgiuqihkkqlfhh.supabase.co/functions/v1/kb/search \
  -H "Content-Type: application/json" \
  -d '{"keyword": "psychological safety", "limit": 5}'

# Context bundle for Claude (use construct id from search)
curl "https://grgoshdgiuqihkkqlfhh.supabase.co/functions/v1/kb/context?id=20072"

# Top correlates for branching
curl "https://grgoshdgiuqihkkqlfhh.supabase.co/functions/v1/kb/correlates?id=20072&limit=10&min_k=5"
```
