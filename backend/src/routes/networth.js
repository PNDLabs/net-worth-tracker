const express = require('express');
const router = express.Router();
const db = require('../db/database');

function calcNetWorth(conn) {
  const accountsTotal = conn.prepare('SELECT COALESCE(SUM(balance), 0) as total FROM accounts').get().total;
  const holdingsTotal = conn.prepare(
    `SELECT COALESCE(SUM(COALESCE(current_value, shares * COALESCE(current_price, 0))), 0) as total FROM holdings`
  ).get().total;
  const assetsTotal = conn.prepare('SELECT COALESCE(SUM(current_value), 0) as total FROM assets').get().total;
  const liabilitiesTotal = conn.prepare('SELECT COALESCE(SUM(ABS(current_balance)), 0) as total FROM liabilities').get().total;
  const sipTotal = conn.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM sip_installments').get().total;

  const totalAssets = accountsTotal + holdingsTotal + assetsTotal + sipTotal;
  const totalLiabilities = liabilitiesTotal;
  const netWorth = totalAssets - totalLiabilities;

  return { accountsTotal, holdingsTotal, assetsTotal, sipTotal, totalAssets, totalLiabilities, netWorth };
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
