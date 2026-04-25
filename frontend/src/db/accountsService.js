/**
 * accountsService.js – local SQLite CRUD for accounts and holdings.
 * Mirrors the behaviour of backend/src/routes/accounts.js.
 */

import { query, run } from './dbService';

const today = () => new Date().toISOString().slice(0, 10);

// ─── Accounts ─────────────────────────────────────────────────────────────────

export async function getAccounts() {
  return query('SELECT * FROM accounts ORDER BY name');
}

export async function getAccount(id) {
  const rows = await query('SELECT * FROM accounts WHERE id = ?', [id]);
  if (!rows.length) throw new Error('Account not found');
  return rows[0];
}

export async function createAccount({ name, institution, type = 'checking', currency = null, balance = 0, notes }) {
  if (!name) throw new Error('name is required');
  const dup = await query(
    `SELECT id FROM accounts WHERE lower(name)=lower(?) AND lower(coalesce(institution,''))=lower(coalesce(?,''))`,
    [name, institution ?? null]
  );
  if (dup.length) throw Object.assign(new Error('An account with the same name and institution already exists'), { status: 409 });

  const { lastId } = await run(
    `INSERT INTO accounts (name, institution, type, currency, balance, notes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [name, institution ?? null, type, currency, Number(balance), notes ?? null]
  );
  await run(
    `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes)
     VALUES ('account', ?, ?, ?, 'Initial balance')`,
    [lastId, Number(balance), today()]
  );
  const rows = await query('SELECT * FROM accounts WHERE id = ?', [lastId]);
  return rows[0];
}

export async function updateAccount(id, { name, institution, type, currency, balance, notes }) {
  const existing = await getAccount(id);
  const updated = {
    name: name !== undefined ? name : existing.name,
    institution: institution !== undefined ? institution : existing.institution,
    type: type !== undefined ? type : existing.type,
    currency: currency !== undefined ? currency : existing.currency,
    balance: balance !== undefined ? Number(balance) : existing.balance,
    notes: notes !== undefined ? notes : existing.notes,
  };
  if (!updated.name) throw new Error('name is required');

  await run(
    `UPDATE accounts SET name=?, institution=?, type=?, currency=?, balance=?, notes=?, updated_at=datetime('now') WHERE id=?`,
    [updated.name, updated.institution, updated.type, updated.currency, updated.balance, updated.notes, id]
  );
  if (updated.balance !== existing.balance) {
    await run(
      `INSERT INTO value_history (entity_type, entity_id, value, recorded_at) VALUES ('account', ?, ?, ?)`,
      [id, updated.balance, today()]
    );
  }
  const rows = await query('SELECT * FROM accounts WHERE id = ?', [id]);
  return rows[0];
}

export async function deleteAccount(id) {
  await getAccount(id);
  await run('DELETE FROM accounts WHERE id = ?', [id]);
  return { message: 'Account deleted' };
}

// ─── Holdings ─────────────────────────────────────────────────────────────────

export async function getHoldings(accountId) {
  await getAccount(accountId);
  return query('SELECT * FROM holdings WHERE account_id = ? ORDER BY symbol', [accountId]);
}

export async function createHolding(accountId, { symbol, name, shares = 0, cost_basis, current_price, current_value, as_of_date }) {
  await getAccount(accountId);
  if (!symbol) throw new Error('symbol is required');
  const dup = await query(
    `SELECT id FROM holdings WHERE account_id=? AND upper(symbol)=upper(?)`,
    [accountId, symbol]
  );
  if (dup.length) throw Object.assign(new Error('A holding with the same symbol already exists in this account'), { status: 409 });

  const { lastId } = await run(
    `INSERT INTO holdings (account_id, symbol, name, shares, cost_basis, current_price, current_value, as_of_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      accountId,
      symbol.toUpperCase(),
      name ?? null,
      Number(shares),
      cost_basis != null ? Number(cost_basis) : null,
      current_price != null ? Number(current_price) : null,
      current_value != null ? Number(current_value) : null,
      as_of_date ?? null,
    ]
  );
  const rows = await query('SELECT * FROM holdings WHERE id = ?', [lastId]);
  return rows[0];
}
