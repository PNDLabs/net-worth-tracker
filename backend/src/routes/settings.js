const express = require('express');
const router = express.Router();
const db = require('../db/database');

// GET /api/settings — return all settings as a flat object
router.get('/', (req, res) => {
  const rows = db.getDb().prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const { key, value } of rows) {
    try { settings[key] = JSON.parse(value); }
    catch { settings[key] = value; }
  }
  res.json(settings);
});

// PATCH /api/settings — update one or more settings
router.patch('/', express.json(), (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return res.status(400).json({ error: 'Body must be a JSON object of key-value pairs' });
  }

  const conn = db.getDb();
  const upsert = conn.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  );

  const upsertMany = conn.transaction((entries) => {
    for (const [key, value] of entries) {
      upsert.run(String(key), JSON.stringify(value));
    }
  });

  try {
    upsertMany(Object.entries(updates));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Return updated settings
  const rows = conn.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const { key, value } of rows) {
    try { settings[key] = JSON.parse(value); }
    catch { settings[key] = value; }
  }
  res.json(settings);
});

module.exports = router;
