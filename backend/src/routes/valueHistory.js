const express = require('express');
const router = express.Router();
const db = require('../db/database');

const VALID_ENTITY_TYPES = ['account', 'asset', 'liability', 'insurance', 'metal'];

// GET /api/value-history?entity_type=account&entity_id=1
// Returns chronological history for a specific entity
router.get('/', (req, res) => {
  const { entity_type, entity_id } = req.query;

  if (!entity_type || !VALID_ENTITY_TYPES.includes(entity_type)) {
    return res.status(400).json({ error: `entity_type must be one of: ${VALID_ENTITY_TYPES.join(', ')}` });
  }
  if (!entity_id) {
    return res.status(400).json({ error: 'entity_id is required' });
  }

  const rows = db.getDb().prepare(
    `SELECT * FROM value_history
     WHERE entity_type = ? AND entity_id = ?
     ORDER BY recorded_at ASC, id ASC`
  ).all(entity_type, entity_id);

  res.json(rows);
});

// GET /api/value-history/growth?entity_type=account&entity_id=1
// Returns growth summary: first value, latest value, absolute and % change
router.get('/growth', (req, res) => {
  const { entity_type, entity_id } = req.query;

  if (!entity_type || !VALID_ENTITY_TYPES.includes(entity_type)) {
    return res.status(400).json({ error: `entity_type must be one of: ${VALID_ENTITY_TYPES.join(', ')}` });
  }
  if (!entity_id) {
    return res.status(400).json({ error: 'entity_id is required' });
  }

  const conn = db.getDb();
  const first = conn.prepare(
    `SELECT * FROM value_history WHERE entity_type = ? AND entity_id = ?
     ORDER BY recorded_at ASC, id ASC LIMIT 1`
  ).get(entity_type, entity_id);

  const latest = conn.prepare(
    `SELECT * FROM value_history WHERE entity_type = ? AND entity_id = ?
     ORDER BY recorded_at DESC, id DESC LIMIT 1`
  ).get(entity_type, entity_id);

  if (!first || !latest) {
    return res.json({ entity_type, entity_id: Number(entity_id), first_value: null, latest_value: null, absolute_change: null, percent_change: null, data_points: 0 });
  }

  const count = conn.prepare(
    `SELECT COUNT(*) as cnt FROM value_history WHERE entity_type = ? AND entity_id = ?`
  ).get(entity_type, entity_id).cnt;

  const absoluteChange = latest.value - first.value;
  const percentChange = first.value !== 0 ? (absoluteChange / first.value) * 100 : null;

  res.json({
    entity_type,
    entity_id: Number(entity_id),
    first_value: first.value,
    first_date: first.recorded_at,
    latest_value: latest.value,
    latest_date: latest.recorded_at,
    absolute_change: absoluteChange,
    percent_change: percentChange !== null ? Math.round(percentChange * 100) / 100 : null,
    data_points: count,
  });
});

// POST /api/value-history — manually record a value for an entity
router.post('/', (req, res) => {
  const { entity_type, entity_id, value, recorded_at, notes } = req.body;

  if (!entity_type || !VALID_ENTITY_TYPES.includes(entity_type)) {
    return res.status(400).json({ error: `entity_type must be one of: ${VALID_ENTITY_TYPES.join(', ')}` });
  }
  if (!entity_id) return res.status(400).json({ error: 'entity_id is required' });
  if (value == null || isNaN(Number(value))) return res.status(400).json({ error: 'value is required and must be a number' });

  const conn = db.getDb();
  const result = conn.prepare(
    `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    entity_type, Number(entity_id), Number(value),
    recorded_at || new Date().toISOString().slice(0, 10),
    notes || null
  );

  const row = conn.prepare('SELECT * FROM value_history WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(row);
});

module.exports = router;
