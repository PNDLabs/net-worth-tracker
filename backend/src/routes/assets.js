const express = require('express');
const router = express.Router();
const db = require('../db/database');

const VALID_CATEGORIES = ['real_estate', 'vehicle', 'crypto', 'collectible', 'business', 'other'];

// GET /api/assets
router.get('/', (req, res) => {
  const assets = db.getDb().prepare('SELECT * FROM assets ORDER BY name').all();
  res.json(assets);
});

// GET /api/assets/:id
router.get('/:id', (req, res) => {
  const asset = db.getDb().prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  res.json(asset);
});

// POST /api/assets
router.post('/', (req, res) => {
  const { name, category = 'other', acquisition_date, acquisition_cost, current_value = 0, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` });
  }

  const conn = db.getDb();
  const result = conn.prepare(
    `INSERT INTO assets (name, category, acquisition_date, acquisition_cost, current_value, notes)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    name, category, acquisition_date || null,
    acquisition_cost != null ? Number(acquisition_cost) : null,
    Number(current_value), notes || null
  );

  const asset = conn.prepare('SELECT * FROM assets WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(asset);
});

// PUT /api/assets/:id
router.put('/:id', (req, res) => {
  const conn = db.getDb();
  const existing = conn.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Asset not found' });

  const { name, category, acquisition_date, acquisition_cost, current_value, notes } = req.body;
  const updated = {
    name: name !== undefined ? name : existing.name,
    category: category !== undefined ? category : existing.category,
    acquisition_date: acquisition_date !== undefined ? acquisition_date : existing.acquisition_date,
    acquisition_cost: acquisition_cost !== undefined ? Number(acquisition_cost) : existing.acquisition_cost,
    current_value: current_value !== undefined ? Number(current_value) : existing.current_value,
    notes: notes !== undefined ? notes : existing.notes,
  };

  if (!updated.name) return res.status(400).json({ error: 'name is required' });

  conn.prepare(
    `UPDATE assets SET name=?, category=?, acquisition_date=?, acquisition_cost=?,
     current_value=?, notes=?, updated_at=datetime('now') WHERE id=?`
  ).run(
    updated.name, updated.category, updated.acquisition_date,
    updated.acquisition_cost, updated.current_value, updated.notes, req.params.id
  );

  const asset = conn.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  res.json(asset);
});

// DELETE /api/assets/:id
router.delete('/:id', (req, res) => {
  const conn = db.getDb();
  const existing = conn.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Asset not found' });

  conn.prepare('DELETE FROM assets WHERE id = ?').run(req.params.id);
  res.json({ message: 'Asset deleted' });
});

module.exports = router;
