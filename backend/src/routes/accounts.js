const express = require('express');
const router = express.Router();
const db = require('../db/database');

// GET /api/accounts
router.get('/', (req, res) => {
  const accounts = db.getDb().prepare('SELECT * FROM accounts ORDER BY name').all();
  res.json(accounts);
});

// GET /api/accounts/:id
router.get('/:id', (req, res) => {
  const account = db.getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  res.json(account);
});

// POST /api/accounts
router.post('/', (req, res) => {
  const { name, institution, type = 'checking', currency = 'USD', balance = 0, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const VALID_TYPES = ['checking', 'savings', 'money_market', 'cd', 'brokerage', '401k', 'ira', 'roth_ira', 'pension', 'other'];
  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
  }

  const conn = db.getDb();
  const duplicate = conn.prepare(
    `SELECT id FROM accounts WHERE lower(name) = lower(?) AND lower(coalesce(institution,'')) = lower(coalesce(?,''))`
  ).get(name, institution || null);
  if (duplicate) return res.status(409).json({ error: 'An account with the same name and institution already exists' });

  const result = conn.prepare(
    `INSERT INTO accounts (name, institution, type, currency, balance, notes)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(name, institution || null, type, currency, Number(balance), notes || null);

  const account = conn.prepare('SELECT * FROM accounts WHERE id = ?').get(result.lastInsertRowid);
  conn.prepare(
    `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes)
     VALUES ('account', ?, ?, date('now'), 'Initial balance')`
  ).run(account.id, account.balance);
  res.status(201).json(account);
});

// PUT /api/accounts/:id
router.put('/:id', (req, res) => {
  const conn = db.getDb();
  const existing = conn.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Account not found' });

  const { name, institution, type, currency, balance, notes } = req.body;
  const updated = {
    name: name !== undefined ? name : existing.name,
    institution: institution !== undefined ? institution : existing.institution,
    type: type !== undefined ? type : existing.type,
    currency: currency !== undefined ? currency : existing.currency,
    balance: balance !== undefined ? Number(balance) : existing.balance,
    notes: notes !== undefined ? notes : existing.notes,
  };

  if (!updated.name) return res.status(400).json({ error: 'name is required' });

  conn.prepare(
    `UPDATE accounts SET name=?, institution=?, type=?, currency=?, balance=?, notes=?,
     updated_at=datetime('now') WHERE id=?`
  ).run(updated.name, updated.institution, updated.type, updated.currency, updated.balance, updated.notes, req.params.id);

  if (updated.balance !== existing.balance) {
    conn.prepare(
      `INSERT INTO value_history (entity_type, entity_id, value, recorded_at)
       VALUES ('account', ?, ?, date('now'))`
    ).run(req.params.id, updated.balance);
  }

  const account = conn.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  res.json(account);
});

// DELETE /api/accounts/:id
router.delete('/:id', (req, res) => {
  const conn = db.getDb();
  const existing = conn.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Account not found' });

  conn.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
  res.json({ message: 'Account deleted' });
});

// GET /api/accounts/:id/holdings
router.get('/:id/holdings', (req, res) => {
  const conn = db.getDb();
  const account = conn.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const holdings = conn.prepare('SELECT * FROM holdings WHERE account_id = ? ORDER BY symbol').all(req.params.id);
  res.json(holdings);
});

// POST /api/accounts/:id/holdings
router.post('/:id/holdings', (req, res) => {
  const conn = db.getDb();
  const account = conn.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const { symbol, name, shares = 0, cost_basis, current_price, current_value, as_of_date } = req.body;
  if (!symbol) return res.status(400).json({ error: 'symbol is required' });

  const duplicate = conn.prepare(
    `SELECT id FROM holdings WHERE account_id = ? AND upper(symbol) = upper(?)`
  ).get(req.params.id, symbol);
  if (duplicate) return res.status(409).json({ error: 'A holding with the same symbol already exists in this account' });

  const result = conn.prepare(
    `INSERT INTO holdings (account_id, symbol, name, shares, cost_basis, current_price, current_value, as_of_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    req.params.id, symbol.toUpperCase(), name || null,
    Number(shares), cost_basis != null ? Number(cost_basis) : null,
    current_price != null ? Number(current_price) : null,
    current_value != null ? Number(current_value) : null,
    as_of_date || null
  );

  const holding = conn.prepare('SELECT * FROM holdings WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(holding);
});

module.exports = router;
