/**
 * assetsService.js – local SQLite CRUD for assets.
 * Mirrors backend/src/routes/assets.js.
 */

import { query, run } from './dbService';

const today = () => new Date().toISOString().slice(0, 10);

export async function getAssets() {
  return query('SELECT * FROM assets ORDER BY name');
}

export async function getAsset(id) {
  const rows = await query('SELECT * FROM assets WHERE id = ?', [id]);
  if (!rows.length) throw new Error('Asset not found');
  return rows[0];
}

export async function createAsset({ name, category = 'other', acquisition_date, acquisition_cost, current_value = 0, notes }) {
  if (!name) throw new Error('name is required');
  const dup = await query(`SELECT id FROM assets WHERE lower(name)=lower(?)`, [name]);
  if (dup.length) throw Object.assign(new Error('An asset with the same name already exists'), { status: 409 });

  const { lastId } = await run(
    `INSERT INTO assets (name, category, acquisition_date, acquisition_cost, current_value, notes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [name, category, acquisition_date ?? null, acquisition_cost != null ? Number(acquisition_cost) : null, Number(current_value), notes ?? null]
  );
  await run(
    `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes)
     VALUES ('asset', ?, ?, ?, 'Initial value')`,
    [lastId, Number(current_value), today()]
  );
  const rows = await query('SELECT * FROM assets WHERE id = ?', [lastId]);
  return rows[0];
}

export async function updateAsset(id, { name, category, acquisition_date, acquisition_cost, current_value, notes }) {
  const existing = await getAsset(id);
  const updated = {
    name: name !== undefined ? name : existing.name,
    category: category !== undefined ? category : existing.category,
    acquisition_date: acquisition_date !== undefined ? acquisition_date : existing.acquisition_date,
    acquisition_cost: acquisition_cost !== undefined ? (acquisition_cost != null ? Number(acquisition_cost) : null) : existing.acquisition_cost,
    current_value: current_value !== undefined ? Number(current_value) : existing.current_value,
    notes: notes !== undefined ? notes : existing.notes,
  };
  if (!updated.name) throw new Error('name is required');

  await run(
    `UPDATE assets SET name=?, category=?, acquisition_date=?, acquisition_cost=?, current_value=?, notes=?, updated_at=datetime('now') WHERE id=?`,
    [updated.name, updated.category, updated.acquisition_date, updated.acquisition_cost, updated.current_value, updated.notes, id]
  );
  if (updated.current_value !== existing.current_value) {
    await run(
      `INSERT INTO value_history (entity_type, entity_id, value, recorded_at) VALUES ('asset', ?, ?, ?)`,
      [id, updated.current_value, today()]
    );
  }
  const rows = await query('SELECT * FROM assets WHERE id = ?', [id]);
  return rows[0];
}

export async function deleteAsset(id) {
  await getAsset(id);
  await run('DELETE FROM assets WHERE id = ?', [id]);
  return { message: 'Asset deleted' };
}
