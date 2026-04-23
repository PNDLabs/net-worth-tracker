/**
 * valueHistoryService.js – value history queries.
 * Mirrors backend/src/routes/valueHistory.js.
 */

import { query, run } from './dbService';

const today = () => new Date().toISOString().slice(0, 10);

export async function getValueHistory(entityType, entityId) {
  return query(
    `SELECT * FROM value_history WHERE entity_type=? AND entity_id=? ORDER BY recorded_at ASC, id ASC`,
    [entityType, entityId]
  );
}

export async function getValueGrowth(entityType, entityId) {
  const all = await query(
    `SELECT * FROM value_history WHERE entity_type=? AND entity_id=? ORDER BY recorded_at ASC, id ASC`,
    [entityType, entityId]
  );
  if (!all.length) {
    return { entity_type: entityType, entity_id: Number(entityId), first_value: null, latest_value: null, absolute_change: null, percent_change: null, data_points: 0 };
  }
  const first = all[0];
  const latest = all[all.length - 1];
  const absoluteChange = latest.value - first.value;
  const percentChange = first.value !== 0 ? (absoluteChange / first.value) * 100 : null;
  return {
    entity_type: entityType,
    entity_id: Number(entityId),
    first_value: first.value,
    first_date: first.recorded_at,
    latest_value: latest.value,
    latest_date: latest.recorded_at,
    absolute_change: absoluteChange,
    percent_change: percentChange !== null ? Math.round(percentChange * 100) / 100 : null,
    data_points: all.length,
  };
}

export async function recordValue({ entity_type, entity_id, value, recorded_at, notes }) {
  if (!entity_type) throw new Error('entity_type is required');
  if (!entity_id) throw new Error('entity_id is required');
  if (value == null || isNaN(Number(value))) throw new Error('value is required and must be a number');
  const { lastId } = await run(
    `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes) VALUES (?, ?, ?, ?, ?)`,
    [entity_type, Number(entity_id), Number(value), recorded_at || today(), notes ?? null]
  );
  const rows = await query('SELECT * FROM value_history WHERE id = ?', [lastId]);
  return rows[0];
}
