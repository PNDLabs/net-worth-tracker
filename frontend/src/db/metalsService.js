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

// Spot prices always returned in USD by api.metals.live
const SPOT_PRICE_URL = 'https://api.metals.live/v1/spot';
// Open Exchange Rates free endpoint – used only for fiat currency conversion.
// The free tier does NOT include precious-metal ISO codes (XAU/XAG/XPT/XPD).
const FOREX_URL = 'https://open.er-api.com/v6/latest/USD';

// CoinCap v2 rates endpoint – free, no API key required.
// Returns an array of rate objects with { id, symbol, rateUsd, type }.
// For precious metals: id="gold" → rateUsd is USD price per 1 troy oz.
const COINCAP_RATES_URL = 'https://api.coincap.io/v2/rates';

// Mapping from VALID_METAL_TYPES to CoinCap rate IDs
const METAL_COINCAP_IDS = { gold: 'gold', silver: 'silver', platinum: 'platinum', palladium: 'palladium' };

/**
 * Fetch the USD → targetCurrency exchange rate from open.er-api.com.
 * Returns 1.0 immediately for USD without a network call.
 */
async function fetchExchangeRate(targetCurrency) {
  if (!targetCurrency || targetCurrency === 'USD') return 1.0;
  const resp = await fetch(FOREX_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`Exchange rate API returned ${resp.status}`);
  const data = await resp.json();
  const rate = data?.rates?.[targetCurrency];
  if (!rate) throw new Error(`No exchange rate found for currency: ${targetCurrency}`);
  return Number(rate);
}

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
 * Fallback price source: CoinCap v2 rates API.
 * https://api.coincap.io/v2/rates returns an array of rate objects where
 * rateUsd is the USD price per 1 troy ounce for precious metals.
 * FX conversion for non-USD currencies is handled via open.er-api.com.
 */
async function fetchSpotPricesFromCoinCap(targetCurrency) {
  const needsFx = targetCurrency && targetCurrency !== 'USD';

  const [coinCapResp, fxResp] = await Promise.all([
    fetch(COINCAP_RATES_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    }),
    needsFx
      ? fetch(FOREX_URL, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(8000),
        })
      : Promise.resolve(null),
  ]);

  if (!coinCapResp.ok) throw new Error(`CoinCap API returned ${coinCapResp.status}`);
  const coinCapData = await coinCapResp.json();
  const ratesList = coinCapData?.data;
  if (!Array.isArray(ratesList)) {
    throw new Error('Unexpected response format from CoinCap API');
  }

  const metalUsdPrices = {};
  for (const rate of ratesList) {
    for (const [metal, id] of Object.entries(METAL_COINCAP_IDS)) {
      if (rate.id === id) {
        const price = parseFloat(rate.rateUsd);
        if (price > 0) metalUsdPrices[metal] = price;
      }
    }
  }
  if (Object.keys(metalUsdPrices).length === 0) {
    throw new Error('No precious metal rates found in CoinCap API response');
  }

  let fxRate = 1.0;
  if (needsFx && fxResp) {
    if (!fxResp.ok) throw new Error(`Exchange rate API returned ${fxResp.status}`);
    const fxData = await fxResp.json();
    fxRate = fxData?.rates?.[targetCurrency];
    if (!fxRate) throw new Error(`No exchange rate found for currency: ${targetCurrency}`);
  }

  const result = {};
  for (const metal of VALID_METAL_TYPES) {
    if (metalUsdPrices[metal] != null) {
      result[metal] = (metalUsdPrices[metal] / GRAMS_PER_TROY_OZ) * fxRate;
    }
  }
  return result;
}

/**
 * Fetch live spot prices in targetCurrency per gram.
 * Primary: api.metals.live.  Fallback: api.coincap.io/v2/rates (free, no key).
 */
async function fetchSpotPricesPerGram(targetCurrency = 'USD') {
  try {
    const resp = await fetch(SPOT_PRICE_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) throw new Error(`Spot price API returned ${resp.status}`);
    const data = await resp.json();
    const raw = Array.isArray(data) ? data[0] : data;
    if (!raw || typeof raw !== 'object') throw new Error('Unexpected response format from spot price API');

    const fxRate = await fetchExchangeRate(targetCurrency);
    const prices = {};
    for (const metal of VALID_METAL_TYPES) {
      if (raw[metal] != null) prices[metal] = (Number(raw[metal]) / GRAMS_PER_TROY_OZ) * fxRate;
    }
    return prices;
  } catch (primaryErr) {
    try {
      return await fetchSpotPricesFromCoinCap(targetCurrency);
    } catch (fallbackErr) {
      throw new Error(
        `Primary (metals.live): ${primaryErr.message}; Fallback (CoinCap): ${fallbackErr.message}`
      );
    }
  }
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
 * Fetch live spot prices (primary: api.metals.live, fallback: open.er-api.com FX rates),
 * convert to user's currency, and update all metal holdings in local SQLite.
 * Returns { updated, prices, currency, unit }.
 */
export async function refreshPrices() {
  const currency = await getUserCurrency();
  const prices = await fetchSpotPricesPerGram(currency);

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

/**
 * Fetch live spot prices without persisting them (primary: api.metals.live, fallback: CoinCap).
 * Returns { prices, currency, unit, source }.
 */
export async function getSpotPrices() {
  const currency = await getUserCurrency();
  const prices = await fetchSpotPricesPerGram(currency);
  return { prices, currency, unit: `${currency}_per_gram`, source: SPOT_PRICE_URL };
}

export { parsePurity, GRAMS_PER_TROY_OZ };
