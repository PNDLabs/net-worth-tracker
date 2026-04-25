/**
 * metals.js – REST routes for precious metals holdings.
 *
 * Supports gold, silver, platinum, and palladium in physical or digital form.
 * Live spot prices are fetched from api.metals.live (free, no key required)
 * and converted from USD/troy-oz to USD/gram.  Value is calculated as:
 *
 *   current_value = quantity_grams × parsePurity(purity) × current_price_gram
 *
 * Routes:
 *   GET    /api/metals               – list all holdings
 *   GET    /api/metals/spot-prices   – fetch live spot prices (read-only)
 *   POST   /api/metals/refresh-prices – fetch + persist prices, update values
 *   GET    /api/metals/:id           – single holding
 *   POST   /api/metals               – create holding
 *   PUT    /api/metals/:id           – update holding
 *   DELETE /api/metals/:id           – delete holding
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');

const VALID_METAL_TYPES = ['gold', 'silver', 'platinum', 'palladium'];
const VALID_METAL_FORMS = ['physical', 'digital'];

// 1 troy ounce = 31.1035 grams
const GRAMS_PER_TROY_OZ = 31.1035;

// Metals.live free spot-price endpoint (no API key required)
const SPOT_PRICE_URL = 'https://api.metals.live/v1/spot';

/**
 * Parse a purity string and return a fraction (0–1).
 * Supported formats:
 *   karat  – "24k", "22k", "18k", "14k", "10k"  → karat/24
 *   fine   – "999", "999.9", "999.5", "925"       → value/1000
 *   pct    – "99.9%", "91.67%"                     → value/100
 *   empty  – null / "" / undefined                 → 1.0 (assume pure)
 */
function parsePurity(purity) {
  if (!purity) return 1.0;
  const s = String(purity).trim().toLowerCase();
  // karat notation: e.g. "22k", "18k"
  const karatMatch = s.match(/^(\d+(\.\d+)?)k$/);
  if (karatMatch) return Math.min(parseFloat(karatMatch[1]) / 24, 1.0);
  // percentage: e.g. "91.67%"
  const pctMatch = s.match(/^(\d+(\.\d+)?)%$/);
  if (pctMatch) return Math.min(parseFloat(pctMatch[1]) / 100, 1.0);
  // millesimal fineness: e.g. "999.9", "925"
  const num = parseFloat(s);
  if (!isNaN(num)) {
    if (num > 1) return Math.min(num / 1000, 1.0);
    return Math.min(num, 1.0); // already a fraction
  }
  return 1.0;
}

/**
 * Fetch live spot prices from api.metals.live.
 * Returns an object { gold, silver, platinum, palladium } in USD per gram,
 * or throws an Error on failure.
 */
async function fetchSpotPricesPerGram() {
  const resp = await fetch(SPOT_PRICE_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`Spot price API returned ${resp.status}`);
  const data = await resp.json();

  // The API returns an array with one object: [{ gold, silver, platinum, palladium }]
  const prices = Array.isArray(data) ? data[0] : data;
  if (!prices || typeof prices !== 'object') {
    throw new Error('Unexpected response format from spot price API');
  }

  const result = {};
  for (const metal of VALID_METAL_TYPES) {
    if (prices[metal] != null) {
      result[metal] = Number(prices[metal]) / GRAMS_PER_TROY_OZ;
    }
  }
  return result;
}

// ── GET /api/metals/spot-prices ──────────────────────────────────────────────

router.get('/spot-prices', async (req, res) => {
  try {
    const prices = await fetchSpotPricesPerGram();
    res.json({ prices, unit: 'USD_per_gram', source: SPOT_PRICE_URL });
  } catch (err) {
    res.status(502).json({ error: `Could not fetch spot prices: ${err.message}` });
  }
});

// ── POST /api/metals/refresh-prices ─────────────────────────────────────────

router.post('/refresh-prices', async (req, res) => {
  const conn = db.getDb();
  let prices;
  try {
    prices = await fetchSpotPricesPerGram();
  } catch (err) {
    return res.status(502).json({ error: `Could not fetch spot prices: ${err.message}` });
  }

  const now = new Date().toISOString();
  const metals = conn.prepare('SELECT * FROM precious_metals').all();
  let updated = 0;

  const update = conn.prepare(
    `UPDATE precious_metals
     SET current_price_gram=?, current_value=?, last_price_update=?, updated_at=datetime('now')
     WHERE id=?`
  );
  const insertHistory = conn.prepare(
    `INSERT INTO value_history (entity_type, entity_id, value, recorded_at)
     VALUES ('metal', ?, ?, date('now'))`
  );

  conn.transaction(() => {
    for (const m of metals) {
      const pricePerGram = prices[m.metal_type];
      if (pricePerGram == null) continue;
      const purityFactor = parsePurity(m.purity);
      const newValue = m.quantity_grams * purityFactor * pricePerGram;
      update.run(pricePerGram, newValue, now, m.id);
      if (Math.abs(newValue - m.current_value) > 0.0001) {
        insertHistory.run(m.id, newValue);
      }
      updated++;
    }
  })();

  res.json({ updated, prices, unit: 'USD_per_gram' });
});

// ── GET /api/metals ──────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const metals = db.getDb().prepare('SELECT * FROM precious_metals ORDER BY metal_type, name').all();
  res.json(metals);
});

// ── GET /api/metals/:id ──────────────────────────────────────────────────────

router.get('/:id', (req, res) => {
  const metal = db.getDb().prepare('SELECT * FROM precious_metals WHERE id = ?').get(req.params.id);
  if (!metal) return res.status(404).json({ error: 'Metal holding not found' });
  res.json(metal);
});

// ── POST /api/metals ─────────────────────────────────────────────────────────

router.post('/', (req, res) => {
  const {
    name,
    metal_type = 'gold',
    metal_form = 'physical',
    purity,
    quantity_grams = 0,
    acquisition_date,
    acquisition_cost,
    current_price_gram,
    notes,
  } = req.body;

  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!VALID_METAL_TYPES.includes(metal_type)) {
    return res.status(400).json({ error: `metal_type must be one of: ${VALID_METAL_TYPES.join(', ')}` });
  }
  if (!VALID_METAL_FORMS.includes(metal_form)) {
    return res.status(400).json({ error: `metal_form must be one of: ${VALID_METAL_FORMS.join(', ')}` });
  }

  const conn = db.getDb();
  const qg = Number(quantity_grams) || 0;
  const ppg = current_price_gram != null ? Number(current_price_gram) : null;
  const purityFactor = parsePurity(purity);
  const currentValue = ppg != null ? qg * purityFactor * ppg : 0;

  const result = conn.prepare(
    `INSERT INTO precious_metals
       (name, metal_type, metal_form, purity, quantity_grams, acquisition_date,
        acquisition_cost, current_price_gram, current_value, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    name, metal_type, metal_form, purity || null, qg,
    acquisition_date || null,
    acquisition_cost != null ? Number(acquisition_cost) : null,
    ppg, currentValue, notes || null
  );

  conn.prepare(
    `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes)
     VALUES ('metal', ?, ?, date('now'), 'Initial value')`
  ).run(result.lastInsertRowid, currentValue);

  const metal = conn.prepare('SELECT * FROM precious_metals WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(metal);
});

// ── PUT /api/metals/:id ──────────────────────────────────────────────────────

router.put('/:id', (req, res) => {
  const conn = db.getDb();
  const existing = conn.prepare('SELECT * FROM precious_metals WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Metal holding not found' });

  const {
    name, metal_type, metal_form, purity,
    quantity_grams, acquisition_date, acquisition_cost,
    current_price_gram, notes,
  } = req.body;

  const updated = {
    name:               name              !== undefined ? name              : existing.name,
    metal_type:         metal_type        !== undefined ? metal_type        : existing.metal_type,
    metal_form:         metal_form        !== undefined ? metal_form        : existing.metal_form,
    purity:             purity            !== undefined ? purity            : existing.purity,
    quantity_grams:     quantity_grams    !== undefined ? Number(quantity_grams)    : existing.quantity_grams,
    acquisition_date:   acquisition_date  !== undefined ? acquisition_date  : existing.acquisition_date,
    acquisition_cost:   acquisition_cost  !== undefined
                          ? (acquisition_cost != null ? Number(acquisition_cost) : null)
                          : existing.acquisition_cost,
    current_price_gram: current_price_gram !== undefined
                          ? (current_price_gram != null ? Number(current_price_gram) : null)
                          : existing.current_price_gram,
    notes:              notes             !== undefined ? notes             : existing.notes,
  };

  if (!updated.name) return res.status(400).json({ error: 'name is required' });

  const purityFactor = parsePurity(updated.purity);
  const newValue = updated.current_price_gram != null
    ? updated.quantity_grams * purityFactor * updated.current_price_gram
    : existing.current_value;

  conn.prepare(
    `UPDATE precious_metals
     SET name=?, metal_type=?, metal_form=?, purity=?, quantity_grams=?,
         acquisition_date=?, acquisition_cost=?, current_price_gram=?,
         current_value=?, notes=?, updated_at=datetime('now')
     WHERE id=?`
  ).run(
    updated.name, updated.metal_type, updated.metal_form, updated.purity,
    updated.quantity_grams, updated.acquisition_date, updated.acquisition_cost,
    updated.current_price_gram, newValue, updated.notes, req.params.id
  );

  if (Math.abs(newValue - existing.current_value) > 0.0001) {
    conn.prepare(
      `INSERT INTO value_history (entity_type, entity_id, value, recorded_at)
       VALUES ('metal', ?, ?, date('now'))`
    ).run(req.params.id, newValue);
  }

  const metal = conn.prepare('SELECT * FROM precious_metals WHERE id = ?').get(req.params.id);
  res.json(metal);
});

// ── DELETE /api/metals/:id ───────────────────────────────────────────────────

router.delete('/:id', (req, res) => {
  const conn = db.getDb();
  const existing = conn.prepare('SELECT * FROM precious_metals WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Metal holding not found' });
  conn.prepare('DELETE FROM precious_metals WHERE id = ?').run(req.params.id);
  res.json({ message: 'Metal holding deleted' });
});

module.exports = router;
module.exports.parsePurity = parsePurity;
module.exports.GRAMS_PER_TROY_OZ = GRAMS_PER_TROY_OZ;
