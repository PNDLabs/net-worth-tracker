/**
 * importService.js – CSV / JSON / PDF import for the local SQLite path.
 *
 * On Android (Capacitor native) there is no backend server, so:
 *   – CSV is parsed client-side with PapaParse.
 *   – JSON records are inserted directly.
 *   – PDF text is extracted with pdfjs-dist (see pdfService.js) then parsed
 *     by the client-side statementParser (see statementParser.js).
 */

import Papa from 'papaparse';
import { query, run, executeSet } from './dbService';
import { parseStatement, mapCsvColumnsWithAI } from '../hooks/statementParser';
import { extractPdfText } from '../hooks/pdfService';
import { getSettings } from './settingsService';

const today = () => new Date().toISOString().slice(0, 10);

async function readDefaultCurrency() {
  try {
    const cfg = await getSettings();
    const raw = cfg.defaultCurrency;
    if (raw != null) return String(raw).replace(/^"|"$/g, '');
  } catch (_) { /* ignore */ }
  return null;
}

// ─── CSV Column Alias Normalizer (mirrors importRoutes.js) ───────────────────

const COLUMN_ALIASES_COMMON = {
  instrument: 'name',
  scrip: 'name',
  security: 'name',
  stock: 'name',
  company: 'name',
  scheme: 'name',
  fund_name: 'name',
  description: 'name',
  bank: 'institution',
  creditor: 'lender',
};

const COLUMN_ALIASES_BY_TYPE = {
  accounts: {
    'cur._val': 'balance',
    cur_val: 'balance',
    current_value: 'balance',
    market_value: 'balance',
    mkt_value: 'balance',
    portfolio_value: 'balance',
    present_value: 'balance',
  },
  assets: {
    'cur._val': 'current_value',
    cur_val: 'current_value',
    market_value: 'current_value',
    mkt_value: 'current_value',
    portfolio_value: 'current_value',
    present_value: 'current_value',
    'avg._cost': 'acquisition_cost',
    avg_cost: 'acquisition_cost',
    avg_price: 'acquisition_cost',
    average_cost: 'acquisition_cost',
    purchase_price: 'acquisition_cost',
    invested: 'acquisition_cost',
  },
  liabilities: {
    outstanding_balance: 'current_balance',
    principal_balance: 'current_balance',
    remaining_balance: 'current_balance',
    loan_balance: 'current_balance',
    'avg._cost': 'original_principal',
    avg_cost: 'original_principal',
  },
};

function applyColumnAliases(normalizedRow, importType) {
  const aliases = { ...COLUMN_ALIASES_COMMON, ...(COLUMN_ALIASES_BY_TYPE[importType] || {}) };
  const out = {};
  // Pass 1: copy columns that are NOT aliased (exact schema field names have priority)
  for (const [k, v] of Object.entries(normalizedRow)) {
    if (!aliases[k]) out[k] = v;
  }
  // Pass 2: apply aliased columns without overwriting already-set fields
  for (const [k, v] of Object.entries(normalizedRow)) {
    const target = aliases[k];
    if (target && !(target in out)) out[target] = v;
  }
  return out;
}

// ─── Duplicate detection (mirrors importRoutes.js) ───────────────────────────

/**
 * Returns a string key that uniquely identifies a record's natural key within a batch.
 * Mirrors the getBatchKey helper in importRoutes.js.
 */
function getBatchKey(importType, row) {
  const n = String(row.name || '').toLowerCase().trim();
  if (importType === 'accounts') return `${n}|${String(row.institution || '').toLowerCase().trim()}`;
  if (importType === 'assets') return n;
  if (importType === 'liabilities') return `${n}|${String(row.lender || '').toLowerCase().trim()}`;
  if (importType === 'insurance') return `${n}|${String(row.provider || '').toLowerCase().trim()}|${String(row.insured_name || '').toLowerCase().trim()}`;
  return n;
}

async function getExistingRecord(importType, row) {
  const name = String(row.name || '');
  if (importType === 'accounts') {
    const rows = await query(
      `SELECT id, balance AS value FROM accounts WHERE lower(name)=lower(?) AND lower(coalesce(institution,''))=lower(coalesce(?,''))`,
      [name, row.institution ? String(row.institution) : null]
    );
    return rows.length > 0 ? rows[0] : null;
  }
  if (importType === 'assets') {
    const rows = await query(`SELECT id, current_value AS value FROM assets WHERE lower(name)=lower(?)`, [name]);
    return rows.length > 0 ? rows[0] : null;
  }
  if (importType === 'liabilities') {
    const rows = await query(
      `SELECT id, current_balance AS value FROM liabilities WHERE lower(name)=lower(?) AND lower(coalesce(lender,''))=lower(coalesce(?,''))`,
      [name, row.lender ? String(row.lender) : null]
    );
    return rows.length > 0 ? rows[0] : null;
  }
  if (importType === 'insurance') {
    const rows = await query(
      `SELECT id, coalesce(premium_amount, 0) AS value FROM insurance_plans WHERE lower(name)=lower(?) AND lower(coalesce(provider,''))=lower(coalesce(?,'')) AND lower(coalesce(insured_name,''))=lower(coalesce(?,''))`,
      [name, row.provider ? String(row.provider) : null, row.insured_name ? String(row.insured_name) : null]
    );
    return rows.length > 0 ? rows[0] : null;
  }
  return null;
}

async function isDuplicateRecord(importType, row) {
  return (await getExistingRecord(importType, row)) !== null;
}

/**
 * Check which records (by index) are duplicates in the local SQLite DB or within the batch.
 * Returns { duplicates: [index, ...], withinBatch: [index, ...] }.
 *   duplicates  – indices of records already present in the DB.
 *   withinBatch – indices of records that are duplicates of an earlier row in the same
 *                 batch (in-file duplicates, e.g. a summary and a detail line in one file).
 */
export async function checkDuplicates(importType, records) {
  const duplicates = [];
  const withinBatch = [];
  const seenKeys = new Set();
  for (let i = 0; i < records.length; i++) {
    const key = getBatchKey(importType, records[i]);
    if (seenKeys.has(key)) {
      withinBatch.push(i);
    } else {
      seenKeys.add(key);
    }
    if (await getExistingRecord(importType, records[i])) {
      duplicates.push(i);
    }
  }
  return { duplicates, withinBatch };
}

// ─── Single-row update (mirrors importRoutes.js updateExistingRecord) ─────────

async function updateRow(importType, row, existingId, existingValue, defaultCurrency = null) {
  if (importType === 'accounts') {
    const newBalance = row.balance != null ? Number(row.balance) : Number(existingValue);
    const { name, institution, type, currency = defaultCurrency } = row;
    await executeSet([
      {
        statement: `UPDATE accounts SET name=coalesce(?,name), institution=coalesce(?,institution), type=coalesce(?,type), currency=coalesce(?,currency), balance=?, updated_at=datetime('now') WHERE id=?`,
        values: [name ? String(name) : null, institution ? String(institution) : null, type ? String(type) : null, currency || null, newBalance, existingId],
      },
      {
        statement: `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes) VALUES ('account', ?, ?, date('now'), 'import update')`,
        values: [existingId, newBalance],
      },
    ]);
  } else if (importType === 'assets') {
    const newValue = row.current_value != null ? Number(row.current_value) : Number(existingValue);
    const { name, category, acquisition_date, acquisition_cost } = row;
    await executeSet([
      {
        statement: `UPDATE assets SET name=coalesce(?,name), category=coalesce(?,category), acquisition_date=coalesce(?,acquisition_date), acquisition_cost=coalesce(?,acquisition_cost), current_value=?, updated_at=datetime('now') WHERE id=?`,
        values: [name ? String(name) : null, category ? String(category) : null, acquisition_date ? String(acquisition_date) : null, acquisition_cost != null ? Number(acquisition_cost) : null, newValue, existingId],
      },
      {
        statement: `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes) VALUES ('asset', ?, ?, date('now'), 'import update')`,
        values: [existingId, newValue],
      },
    ]);
  } else if (importType === 'liabilities') {
    const newBalance = row.current_balance != null ? Number(row.current_balance) : Number(existingValue);
    const { name, lender, type, original_principal, interest_rate, minimum_payment } = row;
    await executeSet([
      {
        statement: `UPDATE liabilities SET name=coalesce(?,name), lender=coalesce(?,lender), type=coalesce(?,type), original_principal=coalesce(?,original_principal), current_balance=?, interest_rate=coalesce(?,interest_rate), minimum_payment=coalesce(?,minimum_payment), updated_at=datetime('now') WHERE id=?`,
        values: [name ? String(name) : null, lender ? String(lender) : null, type ? String(type) : null, original_principal != null ? Number(original_principal) : null, newBalance, interest_rate != null ? Number(interest_rate) : null, minimum_payment != null ? Number(minimum_payment) : null, existingId],
      },
      {
        statement: `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes) VALUES ('liability', ?, ?, date('now'), 'import update')`,
        values: [existingId, newBalance],
      },
    ]);
  } else if (importType === 'insurance') {
    const { name, provider, type = 'other', policy_number, premium_amount, premium_frequency = 'monthly', coverage_amount, start_date, end_date, renewal_date, notes, terms, covered_conditions, insured_name, fund_value } = row;
    const newPremium = premium_amount != null ? Number(premium_amount) : Number(existingValue);
    const ops = [
      {
        statement: `UPDATE insurance_plans SET name=coalesce(?,name), provider=coalesce(?,provider), type=coalesce(?,type), policy_number=coalesce(?,policy_number), premium_amount=coalesce(?,premium_amount), premium_frequency=coalesce(?,premium_frequency), coverage_amount=coalesce(?,coverage_amount), start_date=coalesce(?,start_date), end_date=coalesce(?,end_date), renewal_date=coalesce(?,renewal_date), notes=coalesce(?,notes), terms=coalesce(?,terms), covered_conditions=coalesce(?,covered_conditions), insured_name=coalesce(?,insured_name), fund_value=coalesce(?,fund_value), updated_at=datetime('now') WHERE id=?`,
        values: [name ? String(name) : null, provider ? String(provider) : null, type ? String(type) : null, policy_number ? String(policy_number) : null, premium_amount != null ? Number(premium_amount) : null, premium_frequency ? String(premium_frequency) : null, coverage_amount != null ? Number(coverage_amount) : null, start_date ? String(start_date) : null, end_date ? String(end_date) : null, renewal_date ? String(renewal_date) : null, notes ? String(notes) : null, terms ? String(terms) : null, covered_conditions != null ? JSON.stringify(Array.isArray(covered_conditions) ? covered_conditions : []) : null, insured_name ? String(insured_name) : null, fund_value != null ? Number(fund_value) : null, existingId],
      },
      {
        statement: `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes) VALUES ('insurance', ?, ?, date('now'), 'import update')`,
        values: [existingId, newPremium],
      },
    ];
    // Sync or auto-create the linked brokerage account when fund_value is present
    if (fund_value != null && Number(fund_value) > 0) {
      const linkedRows = await query(`SELECT linked_account_id, name, provider FROM insurance_plans WHERE id=?`, [existingId]);
      if (linkedRows.length) {
        const { linked_account_id, name: planName, provider: planProvider } = linkedRows[0];
        if (linked_account_id) {
          // Plan already has a linked account — just sync the balance.
          ops.push({
            statement: `UPDATE accounts SET balance=?, updated_at=datetime('now') WHERE id=?`,
            values: [Number(fund_value), linked_account_id],
          });
          ops.push({
            statement: `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes) VALUES ('account', ?, ?, date('now'), 'insurance fund value update')`,
            values: [linked_account_id, Number(fund_value)],
          });
        } else {
          // No linked account yet — create one now and link it.
          const effectiveName = (name && String(name).trim()) || (planName && String(planName).trim()) || 'Insurance';
          const effectiveProvider = (provider && String(provider).trim()) || (planProvider && String(planProvider).trim()) || null;
          const accountName = `${effectiveName} – Fund`;
          const dupRows = await query(`SELECT id FROM accounts WHERE lower(name)=lower(?)`, [accountName]);
          if (!dupRows.length) {
            const currency = defaultCurrency || 'USD';
            const { lastId: accId } = await run(
              `INSERT INTO accounts (name, institution, type, currency, balance) VALUES (?, ?, 'brokerage', ?, ?)`,
              [accountName, effectiveProvider, currency, Number(fund_value)]
            );
            ops.push({
              statement: `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes) VALUES ('account', ?, ?, date('now'), 'Initial value from insurance fund')`,
              values: [accId, Number(fund_value)],
            });
            ops.push({
              statement: `UPDATE insurance_plans SET linked_account_id=? WHERE id=?`,
              values: [accId, existingId],
            });
          }
        }
      }
    }
    await executeSet(ops);
  } else {
    throw new Error(`Unknown import type: ${importType}`);
  }
}

// ─── Single-row insert (mirrors CSV importRow logic) ─────────────────────────

async function insertRow(importType, row, defaultCurrency = null) {
  if (importType === 'accounts') {
    const { name, institution, type = 'other', currency = defaultCurrency, balance = 0 } = row;
    if (!name) throw new Error('name is required');
    const newBalance = Number(balance);
    const { lastId } = await run(
      `INSERT INTO accounts (name, institution, type, currency, balance) VALUES (?, ?, ?, COALESCE(?, 'USD'), ?)`,
      [String(name), institution ? String(institution) : null, String(type), currency || null, newBalance]
    );
    await run(
      `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes) VALUES ('account', ?, ?, date('now'), 'import')`,
      [lastId, newBalance]
    );
  } else if (importType === 'assets') {
    const { name, category = 'other', acquisition_date, acquisition_cost, current_value = 0 } = row;
    if (!name) throw new Error('name is required');
    const newValue = Number(current_value);
    const { lastId } = await run(
      `INSERT INTO assets (name, category, acquisition_date, acquisition_cost, current_value) VALUES (?, ?, ?, ?, ?)`,
      [String(name), String(category), acquisition_date ? String(acquisition_date) : null,
       acquisition_cost != null ? Number(acquisition_cost) : null, newValue]
    );
    await run(
      `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes) VALUES ('asset', ?, ?, date('now'), 'import')`,
      [lastId, newValue]
    );
  } else if (importType === 'liabilities') {
    const { name, lender, type = 'other', original_principal, current_balance = 0, interest_rate, minimum_payment } = row;
    if (!name) throw new Error('name is required');
    const newBalance = Number(current_balance);
    const { lastId } = await run(
      `INSERT INTO liabilities (name, lender, type, original_principal, current_balance, interest_rate, minimum_payment) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [String(name), lender ? String(lender) : null, String(type),
       original_principal != null ? Number(original_principal) : null, newBalance,
       interest_rate != null ? Number(interest_rate) : null,
       minimum_payment != null ? Number(minimum_payment) : null]
    );
    await run(
      `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes) VALUES ('liability', ?, ?, date('now'), 'import')`,
      [lastId, newBalance]
    );
  } else if (importType === 'insurance') {
    const { name, provider, type = 'other', policy_number, premium_amount, premium_frequency = 'monthly', coverage_amount, start_date, end_date, renewal_date, notes, terms, covered_conditions, insured_name, fund_value } = row;
    if (!name) throw new Error('name is required');
    const covJson = covered_conditions != null
      ? JSON.stringify(Array.isArray(covered_conditions) ? covered_conditions : [])
      : null;
    const { lastId: planId } = await run(
      `INSERT INTO insurance_plans (name, provider, type, policy_number, premium_amount, premium_frequency, coverage_amount, start_date, end_date, renewal_date, notes, terms, covered_conditions, insured_name, fund_value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [String(name), provider ? String(provider) : null, String(type), policy_number ? String(policy_number) : null,
       premium_amount != null ? Number(premium_amount) : null, String(premium_frequency),
       coverage_amount != null ? Number(coverage_amount) : null,
       start_date ? String(start_date) : null, end_date ? String(end_date) : null,
       renewal_date ? String(renewal_date) : null, notes ? String(notes) : null,
       terms ? String(terms) : null, covJson,
       insured_name ? String(insured_name) : null,
       fund_value != null ? Number(fund_value) : null]
    );
    await run(
      `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes) VALUES ('insurance', ?, ?, date('now'), 'import')`,
      [planId, premium_amount != null ? Number(premium_amount) : 0]
    );

    // Auto-create a linked brokerage account so the fund value is immediately
    // visible in net worth without any extra manual step.
    if (fund_value != null && Number(fund_value) > 0) {
      const accountName = `${String(name)} – Fund`;
      const dup = await query(`SELECT id FROM accounts WHERE lower(name)=lower(?)`, [accountName]);
      if (!dup.length) {
        const currency = defaultCurrency || 'USD';
        const { lastId: accId } = await run(
          `INSERT INTO accounts (name, institution, type, currency, balance) VALUES (?, ?, 'brokerage', ?, ?)`,
          [accountName, provider ? String(provider) : null, currency, Number(fund_value)]
        );
        await run(
          `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes) VALUES ('account', ?, ?, date('now'), 'Initial value from insurance fund')`,
          [accId, Number(fund_value)]
        );
        await run(
          `UPDATE insurance_plans SET linked_account_id=? WHERE id=?`,
          [accId, planId]
        );
      }
    }
  } else {
    throw new Error(`Unknown import type: ${importType}`);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Import an array of pre-parsed records directly into SQLite.
 * Skips duplicates.
 * Records with _forceImport: true bypass the duplicate check.
 */
export async function importRecords(importType, records) {
  const defaultCurrency = await readDefaultCurrency();
  const results = { imported: 0, updated: 0, skipped: 0, duplicates: 0, errors: [] };
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    try {
      const existing = await getExistingRecord(importType, row);
      if (existing) {
        if (row._updateExisting) {
          await updateRow(importType, row, existing.id, existing.value, defaultCurrency);
          results.updated++;
          continue;
        }
        if (!row._forceImport) { results.skipped++; results.duplicates++; continue; }
      }
      await insertRow(importType, row, defaultCurrency);
      results.imported++;
    } catch (err) {
      results.skipped++;
      results.errors.push({ row: i + 1, message: err.message });
    }
  }
  return results;
}

/**
 * Parse a CSV File object and import its rows.
 */
export async function importCsv(importType, file) {
  const text = await file.text();
  const { data, errors } = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: true,
    transformHeader: (h) => h.toLowerCase().replace(/\s+/g, '_'),
  });
  if (errors.length && !data.length) {
    throw new Error(`CSV parse error: ${errors[0].message}`);
  }
  const aliasedData = data.map((row) => applyColumnAliases(row, importType));
  return importRecords(importType, aliasedData);
}

/**
 * Preview a CSV file using AI to map arbitrary column headers to the target schema.
 * Falls back to basic key normalization when AI is unavailable.
 *
 * @param {string} importType  – 'accounts'|'assets'|'liabilities'|'insurance'
 * @param {File}   file        – CSV File object
 * @param {object} [aiOptions] – { apiKey, apiUrl, model } from aiSettings.js
 * @returns {Promise<{ import_type, records, method, validation_notes }>}
 */
export async function previewCsv(importType, file, aiOptions = {}) {
  const text = await file.text();
  const { data, errors } = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: true,
  });
  if (errors.length && !data.length) {
    throw new Error(`CSV parse error: ${errors[0].message}`);
  }
  if (data.length === 0) {
    throw new Error('CSV file is empty or has no data rows');
  }

  const headers = Object.keys(data[0]);
  const sampleRows = data.slice(0, 3);

  let mappedRecords;
  let method;
  let validationNotes = [];

  try {
    const aiResult = await mapCsvColumnsWithAI(headers, sampleRows, importType, aiOptions);
    if (aiResult && aiResult.column_mapping) {
      mappedRecords = data.map((row) => {
        const mapped = {};
        for (const [csvCol, targetField] of Object.entries(aiResult.column_mapping)) {
          if (targetField && row[csvCol] !== undefined && row[csvCol] !== null && row[csvCol] !== '') {
            mapped[targetField] = row[csvCol];
          }
        }
        return mapped;
      });
      method = 'ai';
      validationNotes = aiResult.mapping_notes || [];
    } else {
      throw new Error('AI unavailable');
    }
  } catch (aiErr) {
    // AI mapping failed or unavailable — fall back to basic key normalization
    if (aiErr.message !== 'AI unavailable') {
      console.error('CSV AI column mapping failed, falling back to key normalization:', aiErr.message);
    }
    mappedRecords = data.map((row) => {
      const normalized = Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k.toLowerCase().replace(/\s+/g, '_'), v])
      );
      return applyColumnAliases(normalized, importType);
    });
    method = 'pattern';
  }

  return { import_type: importType, records: mappedRecords, method, validation_notes: validationNotes };
}

/**
 * Preview a PDF: extract text then parse with AI/pattern matching.
 * Returns the same shape as the backend /api/import/pdf/preview.
 * @param {object} [aiOptions] – { apiKey, apiUrl, model } passed to parseStatement
 */
export async function previewPdf(file, password, aiOptions = {}) {
  const defaultCurrency = await readDefaultCurrency();
  const buf = await file.arrayBuffer();
  const text = await extractPdfText(buf, password);
  if (!text.trim()) throw new Error('Could not extract text from PDF. The file may be scanned/image-only.');
  return parseStatement(text, { ...aiOptions, defaultCurrency });
}

/**
 * Import a PDF: optionally re-use previewed records, otherwise re-parse.
 * @param {object} [aiOptions] – { apiKey, apiUrl, model } passed to parseStatement
 */
export async function importPdf(file, password, importType, previewedRecords, aiOptions = {}) {
  const defaultCurrency = await readDefaultCurrency();
  let parsed;
  if (previewedRecords) {
    if (!importType) throw new Error('importType is required when previewedRecords is provided');
    parsed = { import_type: importType, records: previewedRecords, method: 'preview' };
  } else {
    const buf = await file.arrayBuffer();
    const text = await extractPdfText(buf, password);
    if (!text.trim()) throw new Error('Could not extract text from PDF.');
    parsed = await parseStatement(text, { ...aiOptions, defaultCurrency });
  }
  const resolvedType = importType || parsed.import_type;
  const result = await importRecords(resolvedType, parsed.records);
  return { ...result, method: parsed.method };
}

/**
 * Parse raw text and return a preview (same shape as backend /api/import/text).
 */
export async function parseText(text, importType) {
  const defaultCurrency = await readDefaultCurrency();
  const result = await parseStatement(text, { defaultCurrency });
  return result;
}
