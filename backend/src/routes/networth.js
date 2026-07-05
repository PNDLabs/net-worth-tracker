const express = require('express');
const router = express.Router();
const db = require('../db/database');

// Account types that are purely cash/deposit (no investment component).
// Investment account types: money_market, brokerage, 401k, ira, roth_ira, pension, other
const CASH_ACCOUNT_TYPES = ['checking', 'savings', 'cd'];
const DEFAULT_FAMILY_MEMBER = 'Self';

function normalizedMemberName(name) {
  if (typeof name !== 'string') return DEFAULT_FAMILY_MEMBER;
  const normalized = name.trim();
  return normalized || DEFAULT_FAMILY_MEMBER;
}

function calcNetWorth(conn) {
  const cashPlaceholders = CASH_ACCOUNT_TYPES.map(() => '?').join(',');
  let cashTotal = 0;
  let investmentAccountsTotal = 0;
  let holdingsTotal = 0;
  let assetsTotal = 0;
  const metalsTotal = conn.prepare('SELECT COALESCE(SUM(current_value), 0) as total FROM precious_metals').get().total;
  let liabilitiesTotal = 0;
  const membersMap = new Map();

  const memberSummary = (memberName) => {
    const key = normalizedMemberName(memberName);
    if (!membersMap.has(key)) {
      membersMap.set(key, {
        name: key,
        cashTotal: 0,
        investmentAccountsTotal: 0,
        accountsTotal: 0,
        holdingsTotal: 0,
        assetsTotal: 0,
        metalsTotal: 0,
        totalAssets: 0,
        totalLiabilities: 0,
        netWorth: 0,
      });
    }
    return membersMap.get(key);
  };

  const accounts = conn.prepare(
    `SELECT
       type,
       COALESCE(balance, 0) AS balance,
       COALESCE(NULLIF(TRIM(family_member), ''), '${DEFAULT_FAMILY_MEMBER}') AS family_member
     FROM accounts`
  ).all();
  for (const account of accounts) {
    const balance = Number(account.balance || 0);
    const member = memberSummary(account.family_member);
    member.accountsTotal += balance;
    if (CASH_ACCOUNT_TYPES.includes(account.type)) {
      cashTotal += balance;
      member.cashTotal += balance;
    } else {
      investmentAccountsTotal += balance;
      member.investmentAccountsTotal += balance;
    }
  }
  const accountsTotal = cashTotal + investmentAccountsTotal;

  const holdings = conn.prepare(
    `SELECT
       COALESCE(NULLIF(TRIM(a.family_member), ''), '${DEFAULT_FAMILY_MEMBER}') AS family_member,
       COALESCE(h.current_value, h.shares * COALESCE(h.current_price, 0), 0) AS value
     FROM holdings h
     JOIN accounts a ON a.id = h.account_id`
  ).all();
  for (const holding of holdings) {
    const value = Number(holding.value || 0);
    holdingsTotal += value;
    memberSummary(holding.family_member).holdingsTotal += value;
  }

  const assets = conn.prepare(
    `SELECT
       COALESCE(current_value, 0) AS value,
       COALESCE(NULLIF(TRIM(family_member), ''), '${DEFAULT_FAMILY_MEMBER}') AS family_member
     FROM assets`
  ).all();
  for (const asset of assets) {
    const value = Number(asset.value || 0);
    assetsTotal += value;
    memberSummary(asset.family_member).assetsTotal += value;
  }

  const liabilities = conn.prepare(
    `SELECT
       ABS(COALESCE(current_balance, 0)) AS value,
       COALESCE(NULLIF(TRIM(family_member), ''), '${DEFAULT_FAMILY_MEMBER}') AS family_member
     FROM liabilities`
  ).all();
  for (const liability of liabilities) {
    const value = Number(liability.value || 0);
    liabilitiesTotal += value;
    memberSummary(liability.family_member).totalLiabilities += value;
  }

  const totalAssets = accountsTotal + holdingsTotal + assetsTotal + metalsTotal;
  const totalLiabilities = liabilitiesTotal;
  const familyNetWorth = totalAssets - totalLiabilities;
  const netWorth = familyNetWorth;

  const members = Array.from(membersMap.values())
    .map((member) => {
      const totalMemberAssets =
        member.accountsTotal +
        member.holdingsTotal +
        member.assetsTotal +
        member.metalsTotal;
      return {
        ...member,
        totalAssets: totalMemberAssets,
        netWorth: totalMemberAssets - member.totalLiabilities,
      };
    })
    .sort((a, b) => {
      if (a.name === DEFAULT_FAMILY_MEMBER) return -1;
      if (b.name === DEFAULT_FAMILY_MEMBER) return 1;
      return a.name.localeCompare(b.name);
    });

  return {
    cashTotal,
    investmentAccountsTotal,
    accountsTotal,
    holdingsTotal,
    assetsTotal,
    metalsTotal,
    totalAssets,
    totalLiabilities,
    netWorth,
    familyNetWorth,
    members,
  };
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
