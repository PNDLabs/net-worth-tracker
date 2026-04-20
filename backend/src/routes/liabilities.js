const express = require('express');
const router = express.Router();
const db = require('../db/database');

const VALID_TYPES = ['mortgage', 'auto', 'student', 'personal', 'credit_card', 'heloc', 'other'];

// GET /api/liabilities
router.get('/', (req, res) => {
  const liabilities = db.getDb().prepare('SELECT * FROM liabilities ORDER BY name').all();
  res.json(liabilities);
});

// GET /api/liabilities/:id
router.get('/:id', (req, res) => {
  const liability = db.getDb().prepare('SELECT * FROM liabilities WHERE id = ?').get(req.params.id);
  if (!liability) return res.status(404).json({ error: 'Liability not found' });
  res.json(liability);
});

// POST /api/liabilities
router.post('/', (req, res) => {
  const {
    name, lender, type = 'other',
    original_principal, current_balance = 0,
    interest_rate, minimum_payment, notes
  } = req.body;

  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
  }

  const conn = db.getDb();
  const result = conn.prepare(
    `INSERT INTO liabilities (name, lender, type, original_principal, current_balance, interest_rate, minimum_payment, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    name, lender || null, type,
    original_principal != null ? Number(original_principal) : null,
    Number(current_balance),
    interest_rate != null ? Number(interest_rate) : null,
    minimum_payment != null ? Number(minimum_payment) : null,
    notes || null
  );

  const liability = conn.prepare('SELECT * FROM liabilities WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(liability);
});

// PUT /api/liabilities/:id
router.put('/:id', (req, res) => {
  const conn = db.getDb();
  const existing = conn.prepare('SELECT * FROM liabilities WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Liability not found' });

  const { name, lender, type, original_principal, current_balance, interest_rate, minimum_payment, notes } = req.body;
  const updated = {
    name: name !== undefined ? name : existing.name,
    lender: lender !== undefined ? lender : existing.lender,
    type: type !== undefined ? type : existing.type,
    original_principal: original_principal !== undefined ? Number(original_principal) : existing.original_principal,
    current_balance: current_balance !== undefined ? Number(current_balance) : existing.current_balance,
    interest_rate: interest_rate !== undefined ? Number(interest_rate) : existing.interest_rate,
    minimum_payment: minimum_payment !== undefined ? Number(minimum_payment) : existing.minimum_payment,
    notes: notes !== undefined ? notes : existing.notes,
  };

  if (!updated.name) return res.status(400).json({ error: 'name is required' });

  conn.prepare(
    `UPDATE liabilities SET name=?, lender=?, type=?, original_principal=?,
     current_balance=?, interest_rate=?, minimum_payment=?, notes=?,
     updated_at=datetime('now') WHERE id=?`
  ).run(
    updated.name, updated.lender, updated.type, updated.original_principal,
    updated.current_balance, updated.interest_rate, updated.minimum_payment,
    updated.notes, req.params.id
  );

  const liability = conn.prepare('SELECT * FROM liabilities WHERE id = ?').get(req.params.id);
  res.json(liability);
});

// DELETE /api/liabilities/:id
router.delete('/:id', (req, res) => {
  const conn = db.getDb();
  const existing = conn.prepare('SELECT * FROM liabilities WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Liability not found' });

  conn.prepare('DELETE FROM liabilities WHERE id = ?').run(req.params.id);
  res.json({ message: 'Liability deleted' });
});

module.exports = router;
