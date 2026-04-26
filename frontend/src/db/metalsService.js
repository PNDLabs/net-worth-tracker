/**
 * metalsService.js – local SQLite CRUD for precious metals holdings.
 * Mirrors backend/src/routes/metals.js.
 */

import { query, run } from './dbService';
import { getSettings } from './settingsService';

const today = () => new Date().toISOString().slice(0, 10);

const VALID_METAL_TYPES = ['gold', 'silver', 'platinum', 'palladium'];
const VALID_METAL_FORMS = ['physical', 'digital'];
const GRAMS_PER_TROY_OZ = 31.1035;

// MetalPriceAPI endpoint – requires an API key (free tier available at metalpriceapi.com).
// base=CURRENCY → rates.XAU = troy_oz per 1 unit of base currency (inverse of price).
// price_per_gram = (1 / rates.XAU) / GRAMS_PER_TROY_OZ
const METAL_PRICE_API_URL = 'https://api.metalpriceapi.com/v1/latest';

// Mapping from VALID_METAL_TYPES to MetalPriceAPI / ISO 4217 currency codes
const METAL_ISO_CODES = { gold: 'XAU', silver: 'XAG', platinum: 'XPT', palladium: 'XPD' };

/**
 * Read the user's defaultCurrency from local settings.
 * Falls back to 'USD'.
 */
async function getUserCurrency() {
  try {
    const settings = await getSettings();
    const raw = settings.defaultCurrency;
    // Settings values may be stored as JSON-encoded strings
    const parsed = raw ? String(raw).replace(/^"|"$/g, '') : null;
    return parsed || 'USD';
  } catch {
    return 'USD';
  }
}

/**
 * Read the MetalPriceAPI key from local settings.
 * Returns null when not configured.
 */
async function getMetalPriceApiKey() {
  try {
    const settings = await getSettings();
    const raw = settings.metalPriceApiKey;
    if (!raw) return null;
    const v = String(raw).replace(/^"|"$/g, '').trim();
    return v || null;
  } catch {
    return null;
  }
}

/**
 * Fetch live spot prices from MetalPriceAPI in targetCurrency per gram.
 * rates.XAU = troy_oz per 1 unit of base currency.
 * price_per_gram = (1 / rates.XAU) / GRAMS_PER_TROY_OZ
 */
async function fetchSpotPricesFromMetalPriceApi(targetCurrency, apiKey) {
  const currencies = Object.values(METAL_ISO_CODES).join(',');
  const url = `${METAL_PRICE_API_URL}?api_key=${encodeURIComponent(apiKey)}&base=${encodeURIComponent(targetCurrency)}&currencies=${currencies}`;
  const resp = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`MetalPriceAPI returned ${resp.status}`);
  const data = await resp.json();
  if (!data.success) {
    throw new Error(`MetalPriceAPI error: ${data.error?.info || data.error || 'unknown error'}`);
  }
  const rates = data?.rates;
  if (!rates || typeof rates !== 'object') {
    throw new Error('Unexpected response format from MetalPriceAPI');
  }

  const result = {};
  for (const metal of VALID_METAL_TYPES) {
    const code = METAL_ISO_CODES[metal];
    const rate = rates[code]; // troy oz per 1 unit of base currency
    if (rate && rate > 0) {
      result[metal] = 1 / (parseFloat(rate) * GRAMS_PER_TROY_OZ);
    }
  }
  if (Object.keys(result).length === 0) {
    throw new Error('No precious metal rates found in MetalPriceAPI response');
  }
  return result;
}

/**
 * Fetch live spot prices in targetCurrency per gram.
 * Requires an API key (metalPriceApiKey setting).
 * Returns { gold, silver, platinum, palladium } in targetCurrency per gram.
 */
async function fetchSpotPricesPerGram(targetCurrency = 'USD', apiKey = null) {
  if (!apiKey) {
    throw new Error('MetalPriceAPI key is not configured. Please add your API key in Settings.');
  }
  return fetchSpotPricesFromMetalPriceApi(targetCurrency, apiKey);
}

/**
 * Parse a purity string and return a fraction (0–1).
 * Mirrors the parsePurity() function in backend/src/routes/metals.js.
 */
function parsePurity(purity) {
  if (!purity) return 1.0;
  const s = String(purity).trim().toLowerCase();
  const karatMatch = s.match(/^(\d+(\.\d+)?)k$/);
  if (karatMatch) return Math.min(parseFloat(karatMatch[1]) / 24, 1.0);
  const pctMatch = s.match(/^(\d+(\.\d+)?)%$/);
  if (pctMatch) return Math.min(parseFloat(pctMatch[1]) / 100, 1.0);
  const num = parseFloat(s);
  if (!isNaN(num)) {
    if (num > 1) return Math.min(num / 1000, 1.0);
    return Math.min(num, 1.0);
  }
  return 1.0;
}

export async function getMetals() {
  return query('SELECT * FROM precious_metals ORDER BY metal_type, name');
}

export async function getMetal(id) {
  const rows = await query('SELECT * FROM precious_metals WHERE id = ?', [id]);
  if (!rows.length) throw new Error('Metal holding not found');
  return rows[0];
}

export async function createMetal({
  name,
  metal_type = 'gold',
  metal_form = 'physical',
  purity,
  quantity_grams = 0,
  acquisition_date,
  acquisition_cost,
  current_price_gram,
  notes,
}) {
  if (!name) throw new Error('name is required');
  if (!VALID_METAL_TYPES.includes(metal_type))
    throw Object.assign(new Error(`metal_type must be one of: ${VALID_METAL_TYPES.join(', ')}`), { status: 400 });
  if (!VALID_METAL_FORMS.includes(metal_form))
    throw Object.assign(new Error(`metal_form must be one of: ${VALID_METAL_FORMS.join(', ')}`), { status: 400 });

  const qg = Number(quantity_grams) || 0;
  const ppg = current_price_gram != null ? Number(current_price_gram) : null;
  const purityFactor = parsePurity(purity);
  const currentValue = ppg != null ? qg * purityFactor * ppg : 0;

  const { lastId } = await run(
    `INSERT INTO precious_metals
       (name, metal_type, metal_form, purity, quantity_grams, acquisition_date,
        acquisition_cost, current_price_gram, current_value, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, metal_type, metal_form, purity ?? null, qg,
     acquisition_date ?? null,
     acquisition_cost != null ? Number(acquisition_cost) : null,
     ppg, currentValue, notes ?? null]
  );
  await run(
    `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes)
     VALUES ('metal', ?, ?, ?, 'Initial value')`,
    [lastId, currentValue, today()]
  );
  const rows = await query('SELECT * FROM precious_metals WHERE id = ?', [lastId]);
  return rows[0];
}

export async function updateMetal(id, {
  name, metal_type, metal_form, purity,
  quantity_grams, acquisition_date, acquisition_cost,
  current_price_gram, notes,
}) {
  const existing = await getMetal(id);
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
  if (!updated.name) throw new Error('name is required');

  const purityFactor = parsePurity(updated.purity);
  const newValue = updated.current_price_gram != null
    ? updated.quantity_grams * purityFactor * updated.current_price_gram
    : existing.current_value;

  await run(
    `UPDATE precious_metals
     SET name=?, metal_type=?, metal_form=?, purity=?, quantity_grams=?,
         acquisition_date=?, acquisition_cost=?, current_price_gram=?,
         current_value=?, notes=?, updated_at=datetime('now')
     WHERE id=?`,
    [updated.name, updated.metal_type, updated.metal_form, updated.purity,
     updated.quantity_grams, updated.acquisition_date, updated.acquisition_cost,
     updated.current_price_gram, newValue, updated.notes, id]
  );
  if (Math.abs(newValue - existing.current_value) > 0.0001) {
    await run(
      `INSERT INTO value_history (entity_type, entity_id, value, recorded_at) VALUES ('metal', ?, ?, ?)`,
      [id, newValue, today()]
    );
  }
  const rows = await query('SELECT * FROM precious_metals WHERE id = ?', [id]);
  return rows[0];
}

export async function deleteMetal(id) {
  await getMetal(id);
  await run('DELETE FROM precious_metals WHERE id = ?', [id]);
  return { message: 'Metal holding deleted' };
}

/**
 * Fetch live spot prices from MetalPriceAPI, convert to user's currency,
 * and update all metal holdings in local SQLite.
 * Returns { updated, prices, currency, unit }.
 */
export async function refreshPrices() {
  const currency = await getUserCurrency();
  const apiKey = await getMetalPriceApiKey();
  const prices = await fetchSpotPricesPerGram(currency, apiKey);

  const metals = await getMetals();
  const now = new Date().toISOString();
  let updated = 0;

  for (const m of metals) {
    const pricePerGram = prices[m.metal_type];
    if (pricePerGram == null) continue;
    const purityFactor = parsePurity(m.purity);
    const newValue = m.quantity_grams * purityFactor * pricePerGram;
    await run(
      `UPDATE precious_metals
       SET current_price_gram=?, current_value=?, last_price_update=?, updated_at=datetime('now')
       WHERE id=?`,
      [pricePerGram, newValue, now, m.id]
    );
    if (Math.abs(newValue - m.current_value) > 0.0001) {
      await run(
        `INSERT INTO value_history (entity_type, entity_id, value, recorded_at) VALUES ('metal', ?, ?, ?)`,
        [m.id, newValue, today()]
      );
    }
    updated++;
  }

  return { updated, prices, currency, unit: `${currency}_per_gram` };
}

export async function getSpotPrices() {
  const currency = await getUserCurrency();
  const apiKey = await getMetalPriceApiKey();
  const prices = await fetchSpotPricesPerGram(currency, apiKey);
  return { prices, currency, unit: `${currency}_per_gram`, source: METAL_PRICE_API_URL };
}

export { parsePurity, GRAMS_PER_TROY_OZ };
