const express = require('express');
const router = express.Router();
const db = require('../db/database');

// Account types that are purely cash/deposit (no investment component).
// Investment account types: money_market, brokerage, 401k, ira, roth_ira, pension, other
const CASH_ACCOUNT_TYPES = ['checking', 'savings', 'cd'];

function calcNetWorth(conn) {
  const cashPlaceholders = CASH_ACCOUNT_TYPES.map(() => '?').join(',');
  const cashTotal = conn.prepare(
    `SELECT COALESCE(SUM(balance), 0) as total FROM accounts WHERE type IN (${cashPlaceholders})`
  ).get(...CASH_ACCOUNT_TYPES).total;
  const investmentAccountsTotal = conn.prepare(
    `SELECT COALESCE(SUM(balance), 0) as total FROM accounts WHERE type NOT IN (${cashPlaceholders})`
  ).get(...CASH_ACCOUNT_TYPES).total;
  // Keep accountsTotal for snapshot compatibility
  const accountsTotal = cashTotal + investmentAccountsTotal;
  const holdingsTotal = conn.prepare(
    `SELECT COALESCE(SUM(COALESCE(current_value, shares * COALESCE(current_price, 0))), 0) as total FROM holdings`
  ).get().total;
  const assetsTotal = conn.prepare('SELECT COALESCE(SUM(current_value), 0) as total FROM assets').get().total;
  const metalsTotal = conn.prepare('SELECT COALESCE(SUM(current_value), 0) as total FROM precious_metals').get().total;
  const liabilitiesTotal = conn.prepare('SELECT COALESCE(SUM(ABS(current_balance)), 0) as total FROM liabilities').get().total;
  const totalAssets = accountsTotal + holdingsTotal + assetsTotal + metalsTotal;
  const totalLiabilities = liabilitiesTotal;
  const netWorth = totalAssets - totalLiabilities;

  return { cashTotal, investmentAccountsTotal, accountsTotal, holdingsTotal, assetsTotal, metalsTotal, totalAssets, totalLiabilities, netWorth };
}

// GET /api/networth
router.get('/', (req, res) => {
  const summary = calcNetWorth(db.getDb());
  res.json(summary);
});

// GET /api/networth/snapshots
router.get('/snapshots', (req, res) => {
  const snapshots = db.getDb().prepare('SELECT * FROM snapshots ORDER BY snapshot_date DESC').all();
  res.json(snapshots);
});

// POST /api/networth/snapshots  — record a manual snapshot of the current net worth
router.post('/snapshots', (req, res) => {
  const conn = db.getDb();
  const { notes, snapshot_date } = req.body || {};
  const { totalAssets, totalLiabilities, netWorth } = calcNetWorth(conn);

  const result = conn.prepare(
    `INSERT INTO snapshots (snapshot_date, total_assets, total_liabilities, net_worth, notes)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    snapshot_date || new Date().toISOString().slice(0, 10),
    totalAssets, totalLiabilities, netWorth,
    notes || null
  );

  const snapshot = conn.prepare('SELECT * FROM snapshots WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(snapshot);
});

module.exports = router;
module.exports.calcNetWorth = calcNetWorth;
