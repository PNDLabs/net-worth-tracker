const express = require('express');
const router = express.Router();
const db = require('../db/database');

// GET /api/sip — list all SIP installments, optionally filtered by symbol or account_id
router.get('/', (req, res) => {
  const { symbol, account_id } = req.query;
  let query = 'SELECT s.*, a.name as account_name FROM sip_installments s LEFT JOIN accounts a ON s.account_id = a.id';
  const params = [];

  const conditions = [];
  if (symbol) { conditions.push('upper(s.symbol) = upper(?)'); params.push(symbol); }
  if (account_id) { conditions.push('s.account_id = ?'); params.push(account_id); }
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY s.installment_date DESC, s.id DESC';

  res.json(db.getDb().prepare(query).all(...params));
});

// GET /api/sip/summary — total invested & units per symbol, with average NAV
router.get('/summary', (req, res) => {
  const rows = db.getDb().prepare(`
    SELECT
      symbol,
      account_id,
      COUNT(*) as installment_count,
      SUM(amount) as total_invested,
      SUM(units) as total_units,
      CASE WHEN SUM(units) > 0 THEN SUM(amount) / SUM(units) ELSE NULL END as average_nav,
      MIN(installment_date) as first_installment_date,
      MAX(installment_date) as last_installment_date
    FROM sip_installments
    GROUP BY symbol, account_id
    ORDER BY total_invested DESC
  `).all();
  res.json(rows);
});

// GET /api/sip/:id
router.get('/:id', (req, res) => {
  const row = db.getDb().prepare('SELECT * FROM sip_installments WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'SIP installment not found' });
  res.json(row);
});

// POST /api/sip
router.post('/', (req, res) => {
  const { name, symbol, account_id, amount, units, nav, installment_date, notes } = req.body;

  if (!name) return res.status(400).json({ error: 'name is required' });
  if (amount == null || isNaN(Number(amount)) || Number(amount) <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }

  const conn = db.getDb();

  if (account_id) {
    const account = conn.prepare('SELECT id FROM accounts WHERE id = ?').get(account_id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
  }

  const result = conn.prepare(
    `INSERT INTO sip_installments (name, symbol, account_id, amount, units, nav, installment_date, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    name,
    symbol ? symbol.toUpperCase() : null,
    account_id ? Number(account_id) : null,
    Number(amount),
    units != null ? Number(units) : null,
    nav != null ? Number(nav) : null,
    installment_date || new Date().toISOString().slice(0, 10),
    notes || null
  );

  const row = conn.prepare('SELECT * FROM sip_installments WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(row);
});

// PUT /api/sip/:id
router.put('/:id', (req, res) => {
  const conn = db.getDb();
  const existing = conn.prepare('SELECT * FROM sip_installments WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'SIP installment not found' });

  const { name, symbol, account_id, amount, units, nav, installment_date, notes } = req.body;
  const updated = {
    name: name !== undefined ? name : existing.name,
    symbol: symbol !== undefined ? (symbol ? symbol.toUpperCase() : null) : existing.symbol,
    account_id: account_id !== undefined ? (account_id ? Number(account_id) : null) : existing.account_id,
    amount: amount !== undefined ? Number(amount) : existing.amount,
    units: units !== undefined ? (units != null ? Number(units) : null) : existing.units,
    nav: nav !== undefined ? (nav != null ? Number(nav) : null) : existing.nav,
    installment_date: installment_date !== undefined ? installment_date : existing.installment_date,
    notes: notes !== undefined ? notes : existing.notes,
  };

  if (!updated.name) return res.status(400).json({ error: 'name is required' });
  if (!updated.amount || updated.amount <= 0) return res.status(400).json({ error: 'amount must be a positive number' });

  conn.prepare(
    `UPDATE sip_installments SET name=?, symbol=?, account_id=?, amount=?, units=?, nav=?, installment_date=?, notes=?
     WHERE id=?`
  ).run(
    updated.name, updated.symbol, updated.account_id, updated.amount,
    updated.units, updated.nav, updated.installment_date, updated.notes,
    req.params.id
  );

  const row = conn.prepare('SELECT * FROM sip_installments WHERE id = ?').get(req.params.id);
  res.json(row);
});

// DELETE /api/sip/:id
router.delete('/:id', (req, res) => {
  const conn = db.getDb();
  const existing = conn.prepare('SELECT * FROM sip_installments WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'SIP installment not found' });

  conn.prepare('DELETE FROM sip_installments WHERE id = ?').run(req.params.id);
  res.json({ message: 'SIP installment deleted' });
});

module.exports = router;
