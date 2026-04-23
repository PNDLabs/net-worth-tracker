/**
 * liabilitiesService.js – local SQLite CRUD for liabilities.
 * Mirrors backend/src/routes/liabilities.js.
 */

import { query, run } from './dbService';

const today = () => new Date().toISOString().slice(0, 10);

export async function getLiabilities() {
  return query('SELECT * FROM liabilities ORDER BY name');
}

export async function getLiability(id) {
  const rows = await query('SELECT * FROM liabilities WHERE id = ?', [id]);
  if (!rows.length) throw new Error('Liability not found');
  return rows[0];
}

export async function createLiability({
  name, lender, type = 'other', original_principal,
  current_balance = 0, interest_rate, minimum_payment, notes,
}) {
  if (!name) throw new Error('name is required');
  const dup = await query(
    `SELECT id FROM liabilities WHERE lower(name)=lower(?) AND lower(coalesce(lender,''))=lower(coalesce(?,''))`,
    [name, lender ?? null]
  );
  if (dup.length) throw Object.assign(new Error('A liability with the same name and lender already exists'), { status: 409 });

  const { lastId } = await run(
    `INSERT INTO liabilities (name, lender, type, original_principal, current_balance, interest_rate, minimum_payment, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name, lender ?? null, type,
      original_principal != null ? Number(original_principal) : null,
      Number(current_balance),
      interest_rate != null ? Number(interest_rate) : null,
      minimum_payment != null ? Number(minimum_payment) : null,
      notes ?? null,
    ]
  );
  await run(
    `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes)
     VALUES ('liability', ?, ?, ?, 'Initial balance')`,
    [lastId, Number(current_balance), today()]
  );
  const rows = await query('SELECT * FROM liabilities WHERE id = ?', [lastId]);
  return rows[0];
}

export async function updateLiability(id, {
  name, lender, type, original_principal,
  current_balance, interest_rate, minimum_payment, notes,
}) {
  const existing = await getLiability(id);
  const updated = {
    name: name !== undefined ? name : existing.name,
    lender: lender !== undefined ? lender : existing.lender,
    type: type !== undefined ? type : existing.type,
    original_principal: original_principal !== undefined ? (original_principal != null ? Number(original_principal) : null) : existing.original_principal,
    current_balance: current_balance !== undefined ? Number(current_balance) : existing.current_balance,
    interest_rate: interest_rate !== undefined ? (interest_rate != null ? Number(interest_rate) : null) : existing.interest_rate,
    minimum_payment: minimum_payment !== undefined ? (minimum_payment != null ? Number(minimum_payment) : null) : existing.minimum_payment,
    notes: notes !== undefined ? notes : existing.notes,
  };
  if (!updated.name) throw new Error('name is required');

  await run(
    `UPDATE liabilities SET name=?, lender=?, type=?, original_principal=?, current_balance=?,
     interest_rate=?, minimum_payment=?, notes=?, updated_at=datetime('now') WHERE id=?`,
    [
      updated.name, updated.lender, updated.type, updated.original_principal,
      updated.current_balance, updated.interest_rate, updated.minimum_payment,
      updated.notes, id,
    ]
  );
  if (updated.current_balance !== existing.current_balance) {
    await run(
      `INSERT INTO value_history (entity_type, entity_id, value, recorded_at) VALUES ('liability', ?, ?, ?)`,
      [id, updated.current_balance, today()]
    );
  }
  const rows = await query('SELECT * FROM liabilities WHERE id = ?', [id]);
  return rows[0];
}

export async function deleteLiability(id) {
  await getLiability(id);
  await run('DELETE FROM liabilities WHERE id = ?', [id]);
  return { message: 'Liability deleted' };
}
