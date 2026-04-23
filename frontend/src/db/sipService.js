/**
 * sipService.js – local SQLite CRUD for SIP installments.
 * Mirrors backend/src/routes/sip.js.
 */

import { query, run } from './dbService';

const today = () => new Date().toISOString().slice(0, 10);

export async function getSipInstallments({ symbol, account_id } = {}) {
  let sql = `SELECT s.*, a.name as account_name
             FROM sip_installments s
             LEFT JOIN accounts a ON s.account_id = a.id`;
  const params = [];
  const conds = [];
  if (symbol) { conds.push('upper(s.symbol)=upper(?)'); params.push(symbol); }
  if (account_id) { conds.push('s.account_id=?'); params.push(account_id); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY s.installment_date DESC, s.id DESC';
  return query(sql, params);
}

export async function getSipSummary() {
  return query(`
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
  `);
}

export async function getSipInstallment(id) {
  const rows = await query('SELECT * FROM sip_installments WHERE id = ?', [id]);
  if (!rows.length) throw new Error('SIP installment not found');
  return rows[0];
}

export async function createSipInstallment({ name, symbol, account_id, amount, units, nav, installment_date, notes }) {
  if (!name) throw new Error('name is required');
  if (amount == null || isNaN(Number(amount)) || Number(amount) <= 0) throw new Error('amount must be a positive number');

  const { lastId } = await run(
    `INSERT INTO sip_installments (name, symbol, account_id, amount, units, nav, installment_date, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name,
      symbol ? symbol.toUpperCase() : null,
      account_id ? Number(account_id) : null,
      Number(amount),
      units != null ? Number(units) : null,
      nav != null ? Number(nav) : null,
      installment_date || today(),
      notes ?? null,
    ]
  );
  const rows = await query('SELECT * FROM sip_installments WHERE id = ?', [lastId]);
  return rows[0];
}

export async function updateSipInstallment(id, { name, symbol, account_id, amount, units, nav, installment_date, notes }) {
  const existing = await getSipInstallment(id);
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
  if (!updated.name) throw new Error('name is required');
  if (!updated.amount || updated.amount <= 0) throw new Error('amount must be a positive number');

  await run(
    `UPDATE sip_installments SET name=?, symbol=?, account_id=?, amount=?, units=?, nav=?, installment_date=?, notes=? WHERE id=?`,
    [updated.name, updated.symbol, updated.account_id, updated.amount, updated.units, updated.nav, updated.installment_date, updated.notes, id]
  );
  const rows = await query('SELECT * FROM sip_installments WHERE id = ?', [id]);
  return rows[0];
}

export async function deleteSipInstallment(id) {
  await getSipInstallment(id);
  await run('DELETE FROM sip_installments WHERE id = ?', [id]);
  return { message: 'SIP installment deleted' };
}
