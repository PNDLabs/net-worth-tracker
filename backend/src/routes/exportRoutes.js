/**
 * exportRoutes.js – full-data export and full-data import for the REST backend.
 *
 * GET  /api/export          – export all data as a versioned JSON file.
 * POST /api/export/import   – import a full-data export JSON payload.
 *
 * The export format is identical to the one produced by the Android local
 * exportService.js so that data can be moved freely between the web app and
 * the Android app.
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');

const APP_VERSION           = '1.7.1';
const EXPORT_SCHEMA_VERSION = 3;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseSettings(rows) {
  const settings = {};
  for (const { key, value } of rows) {
    try { settings[key] = JSON.parse(value); }
    catch { settings[key] = value; }
  }
  return settings;
}

// ─── GET /api/export ─────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  try {
    const conn = db.getDb();

    const payload = {
      schema_version: EXPORT_SCHEMA_VERSION,
      app_version:    APP_VERSION,
      exported_at:    new Date().toISOString(),
      data: {
        accounts:         conn.prepare('SELECT * FROM accounts ORDER BY id').all(),
        holdings:         conn.prepare('SELECT * FROM holdings ORDER BY id').all(),
        assets:           conn.prepare('SELECT * FROM assets ORDER BY id').all(),
        liabilities:      conn.prepare('SELECT * FROM liabilities ORDER BY id').all(),
        insurance_plans:  conn.prepare('SELECT * FROM insurance_plans ORDER BY id').all(),
        sip_installments: conn.prepare('SELECT * FROM sip_installments ORDER BY id').all(),
        precious_metals:  conn.prepare('SELECT * FROM precious_metals ORDER BY id').all(),
        value_history:    conn.prepare('SELECT * FROM value_history ORDER BY id').all(),
        settings:         parseSettings(conn.prepare('SELECT key, value FROM settings').all()),
      },
    };

    const filename = `networth-export-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/export/import ──────────────────────────────────────────────────

router.post('/import', express.json({ limit: '50mb' }), (req, res) => {
  const payload = req.body;

  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid export file: expected a JSON object.' });
  }

  const { schema_version, data } = payload;

  if (typeof schema_version !== 'number' || schema_version < 1) {
    return res.status(400).json({ error: 'Invalid export file: missing or unrecognised schema_version.' });
  }
  if (schema_version > EXPORT_SCHEMA_VERSION) {
    return res.status(422).json({
      error: `This export was created with a newer schema version (${schema_version}). ` +
             `Please update the app to import it.`,
    });
  }
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Invalid export file: missing data section.' });
  }

  const conn = db.getDb();

  const stats = {
    accounts:         { imported: 0, skipped: 0 },
    holdings:         { imported: 0, skipped: 0 },
    assets:           { imported: 0, skipped: 0 },
    liabilities:      { imported: 0, skipped: 0 },
    insurance_plans:  { imported: 0, skipped: 0 },
    sip_installments: { imported: 0, skipped: 0 },
    precious_metals:  { imported: 0, skipped: 0 },
    value_history:    { imported: 0, skipped: 0 },
    settings:         { imported: 0, skipped: 0 },
  };

  // ID remap maps: old id → new id
  const accountIdMap   = {};
  const assetIdMap     = {};
  const liabilityIdMap = {};
  const insuranceIdMap = {};
  const metalIdMap     = {};

  // Which old IDs were freshly inserted (not deduped against existing rows)
  const newAccountOldIds   = new Set();
  const newAssetOldIds     = new Set();
  const newLiabilityOldIds = new Set();
  const newInsuranceOldIds = new Set();
  const newMetalOldIds     = new Set();

  const run = conn.transaction(() => {
    // ── 1. Settings ──────────────────────────────────────────────────────────
    const upsertSetting = conn.prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
    );
    for (const [key, value] of Object.entries(data.settings || {})) {
      // Export payload stores parsed values; re-encode with JSON.stringify to match
      // the backend's settings storage convention (PATCH handler also JSON.stringifies).
      upsertSetting.run(String(key), JSON.stringify(value));
      stats.settings.imported++;
    }

    // ── 2. Accounts ──────────────────────────────────────────────────────────
    const findAccount = conn.prepare(
      `SELECT id FROM accounts
       WHERE lower(name)=lower(?) AND lower(coalesce(institution,''))=lower(coalesce(?,''))`
    );
    const insertAccount = conn.prepare(
      `INSERT INTO accounts (name, institution, type, currency, balance, notes, created_at, updated_at)
       VALUES (?, ?, ?, COALESCE(?, 'USD'), ?, ?, ?, ?)`
    );
    for (const row of (data.accounts || [])) {
      const existing = findAccount.get(String(row.name || ''), row.institution ? String(row.institution) : null);
      if (existing) {
        accountIdMap[row.id] = existing.id;
        stats.accounts.skipped++;
        continue;
      }
      const result = insertAccount.run(
        String(row.name), row.institution ? String(row.institution) : null,
        String(row.type || 'checking'), row.currency || null,
        Number(row.balance || 0), row.notes ? String(row.notes) : null,
        row.created_at || null, row.updated_at || null
      );
      accountIdMap[row.id] = result.lastInsertRowid;
      newAccountOldIds.add(row.id);
      stats.accounts.imported++;
    }

    // ── 3. Assets ────────────────────────────────────────────────────────────
    const findAsset = conn.prepare(`SELECT id FROM assets WHERE lower(name)=lower(?)`);
    const insertAsset = conn.prepare(
      `INSERT INTO assets (name, category, acquisition_date, acquisition_cost, current_value, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of (data.assets || [])) {
      const existing = findAsset.get(String(row.name || ''));
      if (existing) {
        assetIdMap[row.id] = existing.id;
        stats.assets.skipped++;
        continue;
      }
      const result = insertAsset.run(
        String(row.name), String(row.category || 'other'),
        row.acquisition_date ? String(row.acquisition_date) : null,
        row.acquisition_cost != null ? Number(row.acquisition_cost) : null,
        Number(row.current_value || 0),
        row.notes ? String(row.notes) : null,
        row.created_at || null, row.updated_at || null
      );
      assetIdMap[row.id] = result.lastInsertRowid;
      newAssetOldIds.add(row.id);
      stats.assets.imported++;
    }

    // ── 4. Liabilities ───────────────────────────────────────────────────────
    const findLiability = conn.prepare(
      `SELECT id FROM liabilities
       WHERE lower(name)=lower(?) AND lower(coalesce(lender,''))=lower(coalesce(?,''))`
    );
    const insertLiability = conn.prepare(
      `INSERT INTO liabilities
         (name, lender, type, original_principal, current_balance, interest_rate, minimum_payment, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of (data.liabilities || [])) {
      const existing = findLiability.get(String(row.name || ''), row.lender ? String(row.lender) : null);
      if (existing) {
        liabilityIdMap[row.id] = existing.id;
        stats.liabilities.skipped++;
        continue;
      }
      const result = insertLiability.run(
        String(row.name), row.lender ? String(row.lender) : null,
        String(row.type || 'other'),
        row.original_principal != null ? Number(row.original_principal) : null,
        Number(row.current_balance || 0),
        row.interest_rate != null ? Number(row.interest_rate) : null,
        row.minimum_payment != null ? Number(row.minimum_payment) : null,
        row.notes ? String(row.notes) : null,
        row.created_at || null, row.updated_at || null
      );
      liabilityIdMap[row.id] = result.lastInsertRowid;
      newLiabilityOldIds.add(row.id);
      stats.liabilities.imported++;
    }

    // ── 5. Insurance plans ───────────────────────────────────────────────────
    const findInsurance = conn.prepare(
      `SELECT id FROM insurance_plans
       WHERE lower(name)=lower(?) AND lower(coalesce(provider,''))=lower(coalesce(?,''))`
    );
    const insertInsurance = conn.prepare(
      `INSERT INTO insurance_plans
         (name, provider, type, policy_number, premium_amount, premium_frequency,
          coverage_amount, start_date, end_date, renewal_date, notes,
          terms, covered_conditions, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of (data.insurance_plans || [])) {
      const existing = findInsurance.get(String(row.name || ''), row.provider ? String(row.provider) : null);
      if (existing) {
        insuranceIdMap[row.id] = existing.id;
        stats.insurance_plans.skipped++;
        continue;
      }
      const covJson = row.covered_conditions != null
        ? (typeof row.covered_conditions === 'string'
          ? row.covered_conditions
          : JSON.stringify(row.covered_conditions))
        : null;
      const result = insertInsurance.run(
        String(row.name), row.provider ? String(row.provider) : null,
        String(row.type || 'other'), row.policy_number ? String(row.policy_number) : null,
        row.premium_amount != null ? Number(row.premium_amount) : null,
        String(row.premium_frequency || 'monthly'),
        row.coverage_amount != null ? Number(row.coverage_amount) : null,
        row.start_date ? String(row.start_date) : null,
        row.end_date ? String(row.end_date) : null,
        row.renewal_date ? String(row.renewal_date) : null,
        row.notes ? String(row.notes) : null,
        row.terms ? String(row.terms) : null,
        covJson,
        row.created_at || null, row.updated_at || null
      );
      insuranceIdMap[row.id] = result.lastInsertRowid;
      newInsuranceOldIds.add(row.id);
      stats.insurance_plans.imported++;
    }

    // ── 6. Holdings ──────────────────────────────────────────────────────────
    const findHolding = conn.prepare(
      `SELECT id FROM holdings WHERE account_id=? AND upper(symbol)=upper(?)`
    );
    const insertHolding = conn.prepare(
      `INSERT INTO holdings
         (account_id, symbol, name, shares, cost_basis, current_price, current_value, as_of_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of (data.holdings || [])) {
      const newAccountId = accountIdMap[row.account_id];
      if (!newAccountId) { stats.holdings.skipped++; continue; }
      const existing = findHolding.get(newAccountId, String(row.symbol || ''));
      if (existing) { stats.holdings.skipped++; continue; }
      insertHolding.run(
        newAccountId, String(row.symbol).toUpperCase(),
        row.name ? String(row.name) : null,
        Number(row.shares || 0),
        row.cost_basis != null ? Number(row.cost_basis) : null,
        row.current_price != null ? Number(row.current_price) : null,
        row.current_value != null ? Number(row.current_value) : null,
        row.as_of_date ? String(row.as_of_date) : null,
        row.created_at || null, row.updated_at || null
      );
      stats.holdings.imported++;
    }

    // ── 7. SIP installments ──────────────────────────────────────────────────
    const insertSip = conn.prepare(
      `INSERT INTO sip_installments
         (name, symbol, account_id, amount, units, nav, installment_date, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of (data.sip_installments || [])) {
      const newAccountId = row.account_id != null ? (accountIdMap[row.account_id] ?? null) : null;
      insertSip.run(
        String(row.name), row.symbol ? String(row.symbol) : null,
        newAccountId, Number(row.amount),
        row.units != null ? Number(row.units) : null,
        row.nav != null ? Number(row.nav) : null,
        row.installment_date ? String(row.installment_date) : new Date().toISOString().slice(0, 10),
        row.notes ? String(row.notes) : null,
        row.created_at || null
      );
      stats.sip_installments.imported++;
    }

    // ── 8. Precious metals ───────────────────────────────────────────────────
    const findMetal = conn.prepare(
      `SELECT id FROM precious_metals WHERE lower(name)=lower(?) AND lower(metal_type)=lower(?)`
    );
    const insertMetal = conn.prepare(
      `INSERT INTO precious_metals
         (name, metal_type, metal_form, purity, quantity_grams, acquisition_date,
          acquisition_cost, current_price_gram, current_value, last_price_update,
          notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of (data.precious_metals || [])) {
      const existing = findMetal.get(String(row.name || ''), String(row.metal_type || 'gold'));
      if (existing) {
        metalIdMap[row.id] = existing.id;
        stats.precious_metals.skipped++;
        continue;
      }
      const result = insertMetal.run(
        String(row.name), String(row.metal_type || 'gold'),
        String(row.metal_form || 'physical'), row.purity ? String(row.purity) : null,
        Number(row.quantity_grams || 0),
        row.acquisition_date ? String(row.acquisition_date) : null,
        row.acquisition_cost != null ? Number(row.acquisition_cost) : null,
        row.current_price_gram != null ? Number(row.current_price_gram) : null,
        Number(row.current_value || 0),
        row.last_price_update ? String(row.last_price_update) : null,
        row.notes ? String(row.notes) : null,
        row.created_at || null, row.updated_at || null
      );
      metalIdMap[row.id] = result.lastInsertRowid;
      newMetalOldIds.add(row.id);
      stats.precious_metals.imported++;
    }

    // ── 9. Value history ─────────────────────────────────────────────────────
    const insertHistory = conn.prepare(
      `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const entityNewSets = {
      account:   { newOldIds: newAccountOldIds,   idMap: accountIdMap },
      asset:     { newOldIds: newAssetOldIds,      idMap: assetIdMap },
      liability: { newOldIds: newLiabilityOldIds,  idMap: liabilityIdMap },
      insurance: { newOldIds: newInsuranceOldIds,  idMap: insuranceIdMap },
      metal:     { newOldIds: newMetalOldIds,       idMap: metalIdMap },
    };
    for (const row of (data.value_history || [])) {
      const entry = entityNewSets[row.entity_type];
      if (!entry || !entry.newOldIds.has(row.entity_id)) {
        stats.value_history.skipped++;
        continue;
      }
      const newEntityId = entry.idMap[row.entity_id];
      if (!newEntityId) { stats.value_history.skipped++; continue; }
      insertHistory.run(
        String(row.entity_type), newEntityId, Number(row.value),
        row.recorded_at ? String(row.recorded_at) : new Date().toISOString().slice(0, 10),
        row.notes ? String(row.notes) : null,
        row.created_at || null
      );
      stats.value_history.imported++;
    }
  });

  try {
    run();
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
