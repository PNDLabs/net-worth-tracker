/**
 * networthService.js – net worth calculation + snapshot management.
 * Mirrors backend/src/routes/networth.js.
 */

import { query, run } from './dbService';

const today = () => new Date().toISOString().slice(0, 10);

// Account types that are purely cash/deposit (no investment component)
const CASH_ACCOUNT_TYPES = ['checking', 'savings', 'cd'];

async function calcNetWorth() {
  const cashPlaceholders = CASH_ACCOUNT_TYPES.map(() => '?').join(',');
  const [cash]  = await query(
    `SELECT COALESCE(SUM(balance),0) as total FROM accounts WHERE type IN (${cashPlaceholders})`,
    CASH_ACCOUNT_TYPES
  );
  const [invAcc] = await query(
    `SELECT COALESCE(SUM(balance),0) as total FROM accounts WHERE type NOT IN (${cashPlaceholders})`,
    CASH_ACCOUNT_TYPES
  );
  const [hold]  = await query('SELECT COALESCE(SUM(COALESCE(current_value, shares * COALESCE(current_price, 0))),0) as total FROM holdings');
  const [assets] = await query('SELECT COALESCE(SUM(current_value),0) as total FROM assets');
  const [liabs]  = await query('SELECT COALESCE(SUM(ABS(current_balance)),0) as total FROM liabilities');

  const cashTotal               = cash?.total   ?? 0;
  const investmentAccountsTotal = invAcc?.total  ?? 0;
  const accountsTotal           = cashTotal + investmentAccountsTotal;
  const holdingsTotal           = hold?.total  ?? 0;
  const assetsTotal             = assets?.total ?? 0;
  const totalLiabilities = liabs?.total ?? 0;
  const totalAssets     = accountsTotal + holdingsTotal + assetsTotal;
  const netWorth        = totalAssets - totalLiabilities;

  return { cashTotal, investmentAccountsTotal, accountsTotal, holdingsTotal, assetsTotal, totalAssets, totalLiabilities, netWorth };
}

export { calcNetWorth };

export async function getNetWorth() {
  return calcNetWorth();
}

export async function getSnapshots() {
  return query('SELECT * FROM snapshots ORDER BY snapshot_date DESC');
}

export async function createSnapshot({ notes, snapshot_date } = {}) {
  const { totalAssets, totalLiabilities, netWorth } = await calcNetWorth();
  const { lastId } = await run(
    `INSERT INTO snapshots (snapshot_date, total_assets, total_liabilities, net_worth, notes)
     VALUES (?, ?, ?, ?, ?)`,
    [snapshot_date || today(), totalAssets, totalLiabilities, netWorth, notes ?? null]
  );
  const rows = await query('SELECT * FROM snapshots WHERE id = ?', [lastId]);
  return rows[0];
}
