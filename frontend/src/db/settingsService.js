/**
 * settingsService.js – key/value settings stored in local SQLite.
 * Mirrors backend/src/routes/settings.js.
 */

import { query, run } from './dbService';

export async function getSettings() {
  const rows = await query('SELECT key, value FROM settings');
  const cfg = {};
  for (const r of rows) cfg[r.key] = r.value;
  return cfg;
}

export async function updateSettings(updates = {}) {
  for (const [key, value] of Object.entries(updates)) {
    await run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      [key, String(value)]
    );
  }
  return getSettings();
}
