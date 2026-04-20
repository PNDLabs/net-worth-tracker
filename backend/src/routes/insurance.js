const express = require('express');
const router = express.Router();
const db = require('../db/database');

const VALID_TYPES = [
  'life', 'term_life', 'health', 'dental', 'vision', 'auto', 'home',
  'renters', 'disability', 'umbrella', 'travel', 'pet', 'business', 'other',
];
const VALID_FREQUENCIES = ['monthly', 'quarterly', 'semi_annual', 'annual', 'one_time'];

// GET /api/insurance
router.get('/', (req, res) => {
  const plans = db.getDb().prepare('SELECT * FROM insurance_plans ORDER BY name').all();
  res.json(plans);
});

// GET /api/insurance/:id
router.get('/:id', (req, res) => {
  const plan = db.getDb().prepare('SELECT * FROM insurance_plans WHERE id = ?').get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'Insurance plan not found' });
  res.json(plan);
});

// POST /api/insurance
router.post('/', (req, res) => {
  const {
    name, provider, type = 'other', policy_number,
    premium_amount, premium_frequency = 'monthly', coverage_amount,
    start_date, end_date, renewal_date, notes,
  } = req.body;

  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
  }
  if (!VALID_FREQUENCIES.includes(premium_frequency)) {
    return res.status(400).json({ error: `premium_frequency must be one of: ${VALID_FREQUENCIES.join(', ')}` });
  }

  const conn = db.getDb();
  const result = conn.prepare(
    `INSERT INTO insurance_plans
       (name, provider, type, policy_number, premium_amount, premium_frequency,
        coverage_amount, start_date, end_date, renewal_date, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
  );

  const plan = conn.prepare('SELECT * FROM insurance_plans WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(plan);
});

// PUT /api/insurance/:id
router.put('/:id', (req, res) => {
  const conn = db.getDb();
  const existing = conn.prepare('SELECT * FROM insurance_plans WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Insurance plan not found' });

  const {
    name, provider, type, policy_number,
    premium_amount, premium_frequency, coverage_amount,
    start_date, end_date, renewal_date, notes,
  } = req.body;

  const updated = {
    name: name !== undefined ? name : existing.name,
    provider: provider !== undefined ? provider : existing.provider,
    type: type !== undefined ? type : existing.type,
    policy_number: policy_number !== undefined ? policy_number : existing.policy_number,
    premium_amount: premium_amount !== undefined ? (premium_amount != null ? Number(premium_amount) : null) : existing.premium_amount,
    premium_frequency: premium_frequency !== undefined ? premium_frequency : existing.premium_frequency,
    coverage_amount: coverage_amount !== undefined ? (coverage_amount != null ? Number(coverage_amount) : null) : existing.coverage_amount,
    start_date: start_date !== undefined ? start_date : existing.start_date,
    end_date: end_date !== undefined ? end_date : existing.end_date,
    renewal_date: renewal_date !== undefined ? renewal_date : existing.renewal_date,
    notes: notes !== undefined ? notes : existing.notes,
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
         renewal_date=?, notes=?, updated_at=datetime('now')
     WHERE id=?`
  ).run(
    updated.name, updated.provider, updated.type, updated.policy_number,
    updated.premium_amount, updated.premium_frequency, updated.coverage_amount,
    updated.start_date, updated.end_date, updated.renewal_date, updated.notes,
    req.params.id,
  );

  const plan = conn.prepare('SELECT * FROM insurance_plans WHERE id = ?').get(req.params.id);
  res.json(plan);
});

// DELETE /api/insurance/:id
router.delete('/:id', (req, res) => {
  const conn = db.getDb();
  const existing = conn.prepare('SELECT * FROM insurance_plans WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Insurance plan not found' });

  conn.prepare('DELETE FROM insurance_plans WHERE id = ?').run(req.params.id);
  res.json({ message: 'Insurance plan deleted' });
});

module.exports = router;
