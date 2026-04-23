/**
 * exportService.js – full data export / import for the local SQLite path.
 *
 * Export produces a versioned JSON payload containing every table.
 * Import reads that payload, validates the schema version, and merges the
 * records into the local database while remapping primary-key IDs so that
 * foreign-key relationships (holdings → accounts, sip → accounts,
 * value_history → any entity) are preserved even when the target database
 * already contains rows and auto-increment IDs differ.
 *
 * Duplicate-detection strategy mirrors the existing per-table import logic:
 *   • accounts    – name + institution  (skip duplicate, but track its id for remapping)
 *   • assets      – name                (same)
 *   • liabilities – name + lender       (same)
 *   • insurance   – name + provider     (same)
 *   • holdings    – symbol + account_id (skip duplicate)
 *   • sip         – always insert       (no natural unique key)
 *   • value_history – only import for   newly created entities to avoid
 *                     doubling history on entities that already existed
 *   • settings    – always upsert
 */

import { query, run } from './dbService';
import { APP_VERSION, EXPORT_SCHEMA_VERSION } from '../version';

// ─── Export ──────────────────────────────────────────────────────────────────

export async function exportAllData() {
  const [
    accounts,
    holdings,
    assets,
    liabilities,
    insurance_plans,
    sip_installments,
    value_history,
    settingsRows,
  ] = await Promise.all([
    query('SELECT * FROM accounts ORDER BY id'),
    query('SELECT * FROM holdings ORDER BY id'),
    query('SELECT * FROM assets ORDER BY id'),
    query('SELECT * FROM liabilities ORDER BY id'),
    query('SELECT * FROM insurance_plans ORDER BY id'),
    query('SELECT * FROM sip_installments ORDER BY id'),
    query('SELECT * FROM value_history ORDER BY id'),
    query('SELECT key, value FROM settings'),
  ]);

  // Flatten settings into a plain object
  const settings = {};
  for (const { key, value } of settingsRows) {
    try { settings[key] = JSON.parse(value); }
    catch { settings[key] = value; }
  }

  return {
    schema_version: EXPORT_SCHEMA_VERSION,
    app_version: APP_VERSION,
    exported_at: new Date().toISOString(),
    data: {
      accounts,
      holdings,
      assets,
      liabilities,
      insurance_plans,
      sip_installments,
      value_history,
      settings,
    },
  };
}

// ─── Import ───────────────────────────────────────────────────────────────────

/**
 * Import a full-data export payload produced by exportAllData().
 *
 * @param {object} payload  Parsed JSON from the export file.
 * @returns {object}        Per-table import stats.
 */
export async function importAllData(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid export file: expected a JSON object.');
  }

  const { schema_version, data } = payload;

  if (typeof schema_version !== 'number' || schema_version < 1) {
    throw new Error('Invalid export file: missing or unrecognised schema_version.');
  }
  if (schema_version > EXPORT_SCHEMA_VERSION) {
    throw new Error(
      `This export was created with a newer schema version (${schema_version}). ` +
      `Please update the app to import it.`
    );
  }

  if (!data || typeof data !== 'object') {
    throw new Error('Invalid export file: missing data section.');
  }

  const stats = {
    accounts:        { imported: 0, skipped: 0 },
    holdings:        { imported: 0, skipped: 0 },
    assets:          { imported: 0, skipped: 0 },
    liabilities:     { imported: 0, skipped: 0 },
    insurance_plans: { imported: 0, skipped: 0 },
    sip_installments: { imported: 0, skipped: 0 },
    value_history:   { imported: 0, skipped: 0 },
    settings:        { imported: 0, skipped: 0 },
  };

  // Maps: old id → new id for each entity type
  const accountIdMap    = {};
  const assetIdMap      = {};
  const liabilityIdMap  = {};
  const insuranceIdMap  = {};

  // Track which old IDs were newly created (vs mapped to existing rows)
  const newAccountOldIds    = new Set();
  const newAssetOldIds      = new Set();
  const newLiabilityOldIds  = new Set();
  const newInsuranceOldIds  = new Set();

  // ── 1. Settings ────────────────────────────────────────────────────────────
  const settings = data.settings || {};
  for (const [key, value] of Object.entries(settings)) {
    const serialised = typeof value === 'string' ? value : JSON.stringify(value);
    await run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      [key, serialised]
    );
    stats.settings.imported++;
  }

  // ── 2. Accounts ───────────────────────────────────────────────────────────
  for (const row of (data.accounts || [])) {
    const existing = await query(
      `SELECT id FROM accounts
       WHERE lower(name)=lower(?) AND lower(coalesce(institution,''))=lower(coalesce(?,''))`,
      [String(row.name || ''), row.institution ? String(row.institution) : null]
    );
    if (existing.length) {
      accountIdMap[row.id] = existing[0].id;
      stats.accounts.skipped++;
      continue;
    }
    const { lastId } = await run(
      `INSERT INTO accounts (name, institution, type, currency, balance, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(row.name), row.institution ? String(row.institution) : null,
        String(row.type || 'checking'), String(row.currency || 'USD'),
        Number(row.balance || 0), row.notes ? String(row.notes) : null,
        row.created_at || null, row.updated_at || null,
      ]
    );
    accountIdMap[row.id] = lastId;
    newAccountOldIds.add(row.id);
    stats.accounts.imported++;
  }

  // ── 3. Assets ─────────────────────────────────────────────────────────────
  for (const row of (data.assets || [])) {
    const existing = await query(
      `SELECT id FROM assets WHERE lower(name)=lower(?)`,
      [String(row.name || '')]
    );
    if (existing.length) {
      assetIdMap[row.id] = existing[0].id;
      stats.assets.skipped++;
      continue;
    }
    const { lastId } = await run(
      `INSERT INTO assets (name, category, acquisition_date, acquisition_cost, current_value, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(row.name), String(row.category || 'other'),
        row.acquisition_date ? String(row.acquisition_date) : null,
        row.acquisition_cost != null ? Number(row.acquisition_cost) : null,
        Number(row.current_value || 0),
        row.notes ? String(row.notes) : null,
        row.created_at || null, row.updated_at || null,
      ]
    );
    assetIdMap[row.id] = lastId;
    newAssetOldIds.add(row.id);
    stats.assets.imported++;
  }

  // ── 4. Liabilities ────────────────────────────────────────────────────────
  for (const row of (data.liabilities || [])) {
    const existing = await query(
      `SELECT id FROM liabilities
       WHERE lower(name)=lower(?) AND lower(coalesce(lender,''))=lower(coalesce(?,''))`,
      [String(row.name || ''), row.lender ? String(row.lender) : null]
    );
    if (existing.length) {
      liabilityIdMap[row.id] = existing[0].id;
      stats.liabilities.skipped++;
      continue;
    }
    const { lastId } = await run(
      `INSERT INTO liabilities
         (name, lender, type, original_principal, current_balance, interest_rate, minimum_payment, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(row.name), row.lender ? String(row.lender) : null,
        String(row.type || 'other'),
        row.original_principal != null ? Number(row.original_principal) : null,
        Number(row.current_balance || 0),
        row.interest_rate != null ? Number(row.interest_rate) : null,
        row.minimum_payment != null ? Number(row.minimum_payment) : null,
        row.notes ? String(row.notes) : null,
        row.created_at || null, row.updated_at || null,
      ]
    );
    liabilityIdMap[row.id] = lastId;
    newLiabilityOldIds.add(row.id);
    stats.liabilities.imported++;
  }

  // ── 5. Insurance plans ────────────────────────────────────────────────────
  for (const row of (data.insurance_plans || [])) {
    const existing = await query(
      `SELECT id FROM insurance_plans
       WHERE lower(name)=lower(?) AND lower(coalesce(provider,''))=lower(coalesce(?,''))`,
      [String(row.name || ''), row.provider ? String(row.provider) : null]
    );
    if (existing.length) {
      insuranceIdMap[row.id] = existing[0].id;
      stats.insurance_plans.skipped++;
      continue;
    }
    const { lastId } = await run(
      `INSERT INTO insurance_plans
         (name, provider, type, policy_number, premium_amount, premium_frequency,
          coverage_amount, start_date, end_date, renewal_date, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(row.name), row.provider ? String(row.provider) : null,
        String(row.type || 'other'), row.policy_number ? String(row.policy_number) : null,
        row.premium_amount != null ? Number(row.premium_amount) : null,
        String(row.premium_frequency || 'monthly'),
        row.coverage_amount != null ? Number(row.coverage_amount) : null,
        row.start_date ? String(row.start_date) : null,
        row.end_date ? String(row.end_date) : null,
        row.renewal_date ? String(row.renewal_date) : null,
        row.notes ? String(row.notes) : null,
        row.created_at || null, row.updated_at || null,
      ]
    );
    insuranceIdMap[row.id] = lastId;
    newInsuranceOldIds.add(row.id);
    stats.insurance_plans.imported++;
  }

  // ── 6. Holdings ───────────────────────────────────────────────────────────
  for (const row of (data.holdings || [])) {
    const newAccountId = accountIdMap[row.account_id];
    if (!newAccountId) {
      stats.holdings.skipped++;
      continue;
    }
    const existing = await query(
      `SELECT id FROM holdings WHERE account_id=? AND upper(symbol)=upper(?)`,
      [newAccountId, String(row.symbol || '')]
    );
    if (existing.length) {
      stats.holdings.skipped++;
      continue;
    }
    await run(
      `INSERT INTO holdings
         (account_id, symbol, name, shares, cost_basis, current_price, current_value, as_of_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newAccountId, String(row.symbol).toUpperCase(),
        row.name ? String(row.name) : null,
        Number(row.shares || 0),
        row.cost_basis != null ? Number(row.cost_basis) : null,
        row.current_price != null ? Number(row.current_price) : null,
        row.current_value != null ? Number(row.current_value) : null,
        row.as_of_date ? String(row.as_of_date) : null,
        row.created_at || null, row.updated_at || null,
      ]
    );
    stats.holdings.imported++;
  }

  // ── 7. SIP installments ───────────────────────────────────────────────────
  for (const row of (data.sip_installments || [])) {
    const newAccountId = row.account_id != null ? (accountIdMap[row.account_id] ?? null) : null;
    await run(
      `INSERT INTO sip_installments
         (name, symbol, account_id, amount, units, nav, installment_date, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(row.name), row.symbol ? String(row.symbol) : null,
        newAccountId,
        Number(row.amount),
        row.units != null ? Number(row.units) : null,
        row.nav != null ? Number(row.nav) : null,
        row.installment_date ? String(row.installment_date) : new Date().toISOString().slice(0, 10),
        row.notes ? String(row.notes) : null,
        row.created_at || null,
      ]
    );
    stats.sip_installments.imported++;
  }

  // ── 8. Value history ──────────────────────────────────────────────────────
  // Only import history for entities that were newly created in this import
  // run to avoid duplicating history on entities that already existed.
  const entityNewSets = {
    account:   { newOldIds: newAccountOldIds,   idMap: accountIdMap },
    asset:     { newOldIds: newAssetOldIds,      idMap: assetIdMap },
    liability: { newOldIds: newLiabilityOldIds,  idMap: liabilityIdMap },
    insurance: { newOldIds: newInsuranceOldIds,  idMap: insuranceIdMap },
  };

  for (const row of (data.value_history || [])) {
    const entry = entityNewSets[row.entity_type];
    if (!entry) {
      stats.value_history.skipped++;
      continue;
    }
    if (!entry.newOldIds.has(row.entity_id)) {
      stats.value_history.skipped++;
      continue;
    }
    const newEntityId = entry.idMap[row.entity_id];
    if (!newEntityId) {
      stats.value_history.skipped++;
      continue;
    }
    await run(
      `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        String(row.entity_type), newEntityId,
        Number(row.value),
        row.recorded_at ? String(row.recorded_at) : new Date().toISOString().slice(0, 10),
        row.notes ? String(row.notes) : null,
        row.created_at || null,
      ]
    );
    stats.value_history.imported++;
  }

  return stats;
}
