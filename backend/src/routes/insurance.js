const express = require('express');
const router = express.Router();
const db = require('../db/database');

const VALID_TYPES = [
  'life', 'term_life', 'health', 'dental', 'vision', 'auto', 'home',
  'renters', 'disability', 'umbrella', 'travel', 'pet', 'business', 'other',
];
const VALID_FREQUENCIES = ['monthly', 'quarterly', 'semi_annual', 'annual', 'one_time'];

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Parse `covered_conditions` from a DB row (stored as JSON string) to an array.
 * Returns an array; falls back to [] when the column is absent/null/malformed.
 */
function parseCoveredConditions(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); } catch (_) { return []; }
}

function hydratePlan(plan) {
  return { ...plan, covered_conditions: parseCoveredConditions(plan.covered_conditions) };
}

/**
 * Call the configured AI provider with a chat completion request.
 * Returns the parsed JSON object from the AI response, or null when AI is not
 * configured.  Throws on network / parse errors.
 */
async function callAI(systemPrompt, userMessage) {
  const apiKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const apiUrl = process.env.AI_API_URL || 'https://api.openai.com/v1';
  const model  = process.env.AI_MODEL  || 'gpt-4o-mini';

  const response = await fetch(`${apiUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage  },
      ],
      temperature: 0,
      max_tokens: 2048,
    }),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => '');
    throw new Error(`AI API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('AI returned empty response');

  // Strip optional markdown fences before parsing
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(cleaned);
}

const QUERY_SYSTEM_PROMPT = `You are an insurance advisor. You will be given a list of insurance plans (in JSON) with their policy details and coverage terms. Answer the user's question about which plan(s) would apply to their situation.

Return ONLY a JSON object in this exact format – no markdown fences, no prose:
{
  "answer": "<concise explanation of which plans apply and why, in 2-4 sentences>",
  "applicable_plans": [
    { "id": <plan id as integer>, "name": "<plan name>", "reason": "<why this plan applies>", "priority": <1 = primary, 2 = secondary, etc.> }
  ]
}

If no plans apply, return an empty applicable_plans array and explain why in the answer field.
Order applicable_plans by priority (most relevant first).`;

const ANALYSIS_SYSTEM_PROMPT = `You are an insurance portfolio analyst. You will be given a list of insurance plans (in JSON) with their details and coverage terms. Analyze this portfolio for:
1. Overlaps – two or more plans that cover the same risk/condition.
2. Gaps – common risks that are not covered by any plan.
3. Optimization suggestions – concrete recommendations to reduce premiums, eliminate redundant coverage, or fill gaps.

Return ONLY a JSON object in this exact format – no markdown fences, no prose:
{
  "overlaps": [ "<string describing each overlap>" ],
  "gaps": [ "<string describing each coverage gap>" ],
  "suggestions": [ "<string describing each actionable suggestion>" ]
}

Be specific: reference actual plan names when describing overlaps and suggestions.`;

// ── GET /api/insurance ─────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const plans = db.getDb().prepare('SELECT * FROM insurance_plans ORDER BY name').all();
  res.json(plans.map(hydratePlan));
});

// ── GET /api/insurance/analysis ───────────────────────────────────────────────

router.get('/analysis', async (req, res) => {
  try {
    const apiKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: 'AI is not enabled. Configure an AI API key to use coverage analysis.' });
    }

    const plans = db.getDb().prepare('SELECT * FROM insurance_plans ORDER BY name').all()
      .map(hydratePlan);

    if (plans.length === 0) {
      return res.json({ overlaps: [], gaps: ['No insurance plans have been added yet.'], suggestions: [] });
    }

    const userMessage = `Analyze this insurance portfolio:\n${JSON.stringify(plans, null, 2)}`;
    const result = await callAI(ANALYSIS_SYSTEM_PROMPT, userMessage);

    res.json({
      overlaps:    Array.isArray(result.overlaps)     ? result.overlaps    : [],
      gaps:        Array.isArray(result.gaps)          ? result.gaps        : [],
      suggestions: Array.isArray(result.suggestions)  ? result.suggestions : [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/insurance/:id ─────────────────────────────────────────────────────

router.get('/:id', (req, res) => {
  const plan = db.getDb().prepare('SELECT * FROM insurance_plans WHERE id = ?').get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'Insurance plan not found' });
  res.json(hydratePlan(plan));
});

// ── POST /api/insurance ────────────────────────────────────────────────────────

router.post('/', (req, res) => {
  const {
    name, provider, type = 'other', policy_number,
    premium_amount, premium_frequency = 'monthly', coverage_amount,
    start_date, end_date, renewal_date, notes,
    terms, covered_conditions,
  } = req.body;

  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
  }
  if (!VALID_FREQUENCIES.includes(premium_frequency)) {
    return res.status(400).json({ error: `premium_frequency must be one of: ${VALID_FREQUENCIES.join(', ')}` });
  }

  const conn = db.getDb();
  const duplicate = conn.prepare(
    `SELECT id FROM insurance_plans WHERE lower(name) = lower(?) AND lower(coalesce(provider,'')) = lower(coalesce(?,''))`
  ).get(name, provider || null);
  if (duplicate) return res.status(409).json({ error: 'An insurance plan with the same name and provider already exists' });

  const covJson = covered_conditions != null
    ? JSON.stringify(Array.isArray(covered_conditions) ? covered_conditions : [])
    : null;

  const result = conn.prepare(
    `INSERT INTO insurance_plans
       (name, provider, type, policy_number, premium_amount, premium_frequency,
        coverage_amount, start_date, end_date, renewal_date, notes,
        terms, covered_conditions)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    name,
    provider || null,
    type,
    policy_number || null,
    premium_amount != null ? Number(premium_amount) : null,
    premium_frequency,
    coverage_amount != null ? Number(coverage_amount) : null,
    start_date || null,
    end_date || null,
    renewal_date || null,
    notes || null,
    terms || null,
    covJson,
  );

  const plan = conn.prepare('SELECT * FROM insurance_plans WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(hydratePlan(plan));
});

// ── POST /api/insurance/query ──────────────────────────────────────────────────

router.post('/query', async (req, res) => {
  try {
    const { question } = req.body;
    if (!question || !question.trim()) {
      return res.status(400).json({ error: 'question is required' });
    }

    const apiKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: 'AI is not enabled. Configure an AI API key to use coverage queries.' });
    }

    const plans = db.getDb().prepare('SELECT * FROM insurance_plans ORDER BY name').all()
      .map(hydratePlan);

    if (plans.length === 0) {
      return res.json({ answer: 'No insurance plans have been added yet.', applicable_plans: [] });
    }

    const userMessage =
      `INSURANCE PORTFOLIO:\n${JSON.stringify(plans, null, 2)}\n\nQUESTION: ${question.trim()}`;
    const result = await callAI(QUERY_SYSTEM_PROMPT, userMessage);

    res.json({
      answer:           result.answer            || '',
      applicable_plans: Array.isArray(result.applicable_plans) ? result.applicable_plans : [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/insurance/:id ─────────────────────────────────────────────────────

router.put('/:id', (req, res) => {
  const conn = db.getDb();
  const existing = conn.prepare('SELECT * FROM insurance_plans WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Insurance plan not found' });

  const {
    name, provider, type, policy_number,
    premium_amount, premium_frequency, coverage_amount,
    start_date, end_date, renewal_date, notes,
    terms, covered_conditions,
  } = req.body;

  const updated = {
    name:              name              !== undefined ? name              : existing.name,
    provider:          provider          !== undefined ? provider          : existing.provider,
    type:              type              !== undefined ? type              : existing.type,
    policy_number:     policy_number     !== undefined ? policy_number     : existing.policy_number,
    premium_amount:    premium_amount    !== undefined ? (premium_amount    != null ? Number(premium_amount)    : null) : existing.premium_amount,
    premium_frequency: premium_frequency !== undefined ? premium_frequency : existing.premium_frequency,
    coverage_amount:   coverage_amount   !== undefined ? (coverage_amount   != null ? Number(coverage_amount)   : null) : existing.coverage_amount,
    start_date:        start_date        !== undefined ? start_date        : existing.start_date,
    end_date:          end_date          !== undefined ? end_date          : existing.end_date,
    renewal_date:      renewal_date      !== undefined ? renewal_date      : existing.renewal_date,
    notes:             notes             !== undefined ? notes             : existing.notes,
    terms:             terms             !== undefined ? terms             : existing.terms,
    covered_conditions: covered_conditions !== undefined
      ? JSON.stringify(Array.isArray(covered_conditions) ? covered_conditions : [])
      : existing.covered_conditions,
  };

  if (!updated.name) return res.status(400).json({ error: 'name is required' });
  if (!VALID_TYPES.includes(updated.type)) {
    return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
  }
  if (!VALID_FREQUENCIES.includes(updated.premium_frequency)) {
    return res.status(400).json({ error: `premium_frequency must be one of: ${VALID_FREQUENCIES.join(', ')}` });
  }

  conn.prepare(
    `UPDATE insurance_plans
     SET name=?, provider=?, type=?, policy_number=?, premium_amount=?,
         premium_frequency=?, coverage_amount=?, start_date=?, end_date=?,
         renewal_date=?, notes=?, terms=?, covered_conditions=?,
         updated_at=datetime('now')
     WHERE id=?`
  ).run(
    updated.name, updated.provider, updated.type, updated.policy_number,
    updated.premium_amount, updated.premium_frequency, updated.coverage_amount,
    updated.start_date, updated.end_date, updated.renewal_date, updated.notes,
    updated.terms, updated.covered_conditions,
    req.params.id,
  );

  const plan = conn.prepare('SELECT * FROM insurance_plans WHERE id = ?').get(req.params.id);
  res.json(hydratePlan(plan));
});

// ── DELETE /api/insurance/:id ──────────────────────────────────────────────────

router.delete('/:id', (req, res) => {
  const conn = db.getDb();
  const existing = conn.prepare('SELECT * FROM insurance_plans WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Insurance plan not found' });

  conn.prepare('DELETE FROM insurance_plans WHERE id = ?').run(req.params.id);
  res.json({ message: 'Insurance plan deleted' });
});

module.exports = router;
