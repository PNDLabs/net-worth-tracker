const express = require('express');
const router = express.Router();
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const db = require('../db/database');
const { extractPdfText } = require('../utils/pdfExtractor');
const { parseStatement, mapCsvColumnsWithAI } = require('../utils/statementParser');

class DuplicateError extends Error {}

// ─── CSV Column Alias Normalizer ──────────────────────────────────────────────

/**
 * Maps normalized column names (lowercase, underscores) that are common in
 * brokerage/financial CSVs (e.g. Zerodha holdings) to the target schema field
 * names used by the import logic.  Applied when AI column mapping is unavailable.
 *
 * Type-independent aliases (name, institution, lender, etc.)
 */
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

/**
 * Per-import-type aliases for value/cost columns that have different target
 * field names depending on whether the record is an account, asset, etc.
 */
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

/**
 * Apply column aliases to a row that has already been key-normalized
 * (lowercase + underscored).  Explicit schema field names take priority
 * over aliased columns so that a CSV that already uses the canonical
 * field names is never overwritten.
 *
 * @param {object} normalizedRow - row with lowercase/underscored keys
 * @param {string} importType    - 'accounts'|'assets'|'liabilities'|'insurance'
 * @returns {object} row with aliased keys resolved to target field names
 */
function applyColumnAliases(normalizedRow, importType) {
  const aliases = { ...COLUMN_ALIASES_COMMON, ...(COLUMN_ALIASES_BY_TYPE[importType] || {}) };
  const out = {};
  // Pass 1: copy columns that are NOT in the alias map (exact schema field names)
  for (const [k, v] of Object.entries(normalizedRow)) {
    if (!aliases[k]) out[k] = v;
  }
  // Pass 2: apply aliased columns, but never overwrite an already-set field
  for (const [k, v] of Object.entries(normalizedRow)) {
    const target = aliases[k];
    if (target && !(target in out)) out[target] = v;
  }
  return out;
}

function getDefaultCurrency(conn) {
  try {
    const row = conn.prepare('SELECT value FROM settings WHERE key = ?').get('defaultCurrency');
    if (row) return JSON.parse(row.value);
  } catch (_) { /* ignore */ }
  return null;
}

/**
 * Returns true when a row with the same natural key already exists in the DB.
 * @param {string} importType - 'accounts'|'assets'|'liabilities'|'insurance'
 * @param {object} row - record with at least { name, institution?, lender?, provider? }
 */
function isDuplicateRecord(conn, importType, row) {
  return !!getExistingRecord(conn, importType, row);
}

/**
 * Returns a string key that uniquely identifies a record's natural key within a batch.
 * Used to detect within-file duplicates (rows that share the same identity within the
 * same imported file, e.g. a summary line and a detail line for the same account).
 */
function getBatchKey(importType, row) {
  const n = String(row.name || '').toLowerCase().trim();
  if (importType === 'accounts') return `${n}|${String(row.institution || '').toLowerCase().trim()}`;
  if (importType === 'assets') return n;
  if (importType === 'liabilities') return `${n}|${String(row.lender || '').toLowerCase().trim()}`;
  if (importType === 'insurance') return `${n}|${String(row.provider || '').toLowerCase().trim()}|${String(row.insured_name || '').toLowerCase().trim()}`;
  return n;
}

/**
 * Returns the existing DB record (with id and current value) if a matching row exists.
 */
function getExistingRecord(conn, importType, row) {
  const name = String(row.name || '');
  if (importType === 'accounts') {
    return conn.prepare(
      `SELECT id, balance AS value FROM accounts WHERE lower(name) = lower(?) AND lower(coalesce(institution,'')) = lower(coalesce(?,''))`
    ).get(name, row.institution ? String(row.institution) : null);
  }
  if (importType === 'assets') {
    return conn.prepare(`SELECT id, current_value AS value FROM assets WHERE lower(name) = lower(?)`).get(name);
  }
  if (importType === 'liabilities') {
    return conn.prepare(
      `SELECT id, current_balance AS value FROM liabilities WHERE lower(name) = lower(?) AND lower(coalesce(lender,'')) = lower(coalesce(?,''))`
    ).get(name, row.lender ? String(row.lender) : null);
  }
  if (importType === 'insurance') {
    return conn.prepare(
      `SELECT id, coalesce(premium_amount, 0) AS value FROM insurance_plans WHERE lower(name) = lower(?) AND lower(coalesce(provider,'')) = lower(coalesce(?,'')) AND lower(coalesce(insured_name,'')) = lower(coalesce(?,''))`
    ).get(name, row.provider ? String(row.provider) : null, row.insured_name ? String(row.insured_name) : null);
  }
  return null;
}

/**
 * Update an existing record with new values from the import row,
 * recording the old value in value_history for historical tracking.
 * Wrapped in a transaction so the history insert and entity update are atomic.
 */
function updateExistingRecord(conn, importType, row, existingId, existingValue, defaultCurrency) {
  const doUpdate = conn.transaction(() => {
    if (importType === 'accounts') {
      // Guard: only overwrite balance when the incoming row actually provides one
      const newBalance = row.balance != null ? Number(row.balance) : Number(existingValue);
      const { name, institution, type, currency = defaultCurrency } = row;
      conn.prepare(
        `UPDATE accounts SET
           name = coalesce(?, name),
           institution = coalesce(?, institution),
           type = coalesce(?, type),
           currency = coalesce(?, currency),
           balance = ?,
           updated_at = datetime('now')
         WHERE id = ?`
      ).run(
        name ? String(name) : null,
        institution ? String(institution) : null,
        type ? String(type) : null,
        currency || null,
        newBalance,
        existingId
      );
      // Record the new balance in history so the graph reflects the updated value
      conn.prepare(
        `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes)
         VALUES ('account', ?, ?, date('now'), 'import update')`
      ).run(existingId, newBalance);
    } else if (importType === 'assets') {
      const newValue = row.current_value != null ? Number(row.current_value) : Number(existingValue);
      const { name, category, acquisition_date, acquisition_cost } = row;
      conn.prepare(
        `UPDATE assets SET
           name = coalesce(?, name),
           category = coalesce(?, category),
           acquisition_date = coalesce(?, acquisition_date),
           acquisition_cost = coalesce(?, acquisition_cost),
           current_value = ?,
           updated_at = datetime('now')
         WHERE id = ?`
      ).run(
        name ? String(name) : null,
        category ? String(category) : null,
        acquisition_date ? String(acquisition_date) : null,
        acquisition_cost != null ? Number(acquisition_cost) : null,
        newValue,
        existingId
      );
      // Record the new value in history so the graph reflects the updated value
      conn.prepare(
        `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes)
         VALUES ('asset', ?, ?, date('now'), 'import update')`
      ).run(existingId, newValue);
    } else if (importType === 'liabilities') {
      const newBalance = row.current_balance != null ? Number(row.current_balance) : Number(existingValue);
      const { name, lender, type, original_principal, interest_rate, minimum_payment } = row;
      conn.prepare(
        `UPDATE liabilities SET
           name = coalesce(?, name),
           lender = coalesce(?, lender),
           type = coalesce(?, type),
           original_principal = coalesce(?, original_principal),
           current_balance = ?,
           interest_rate = coalesce(?, interest_rate),
           minimum_payment = coalesce(?, minimum_payment),
           updated_at = datetime('now')
         WHERE id = ?`
      ).run(
        name ? String(name) : null,
        lender ? String(lender) : null,
        type ? String(type) : null,
        original_principal != null ? Number(original_principal) : null,
        newBalance,
        interest_rate != null ? Number(interest_rate) : null,
        minimum_payment != null ? Number(minimum_payment) : null,
        existingId
      );
      // Record the new balance in history so the graph reflects the updated value
      conn.prepare(
        `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes)
         VALUES ('liability', ?, ?, date('now'), 'import update')`
      ).run(existingId, newBalance);
    } else if (importType === 'insurance') {
      const { name, provider, type, policy_number, premium_amount, premium_frequency, coverage_amount, start_date, end_date, renewal_date, notes, terms, covered_conditions, insured_name, fund_value } = row;
      const newPremium = premium_amount != null ? Number(premium_amount) : Number(existingValue);
      conn.prepare(
        `UPDATE insurance_plans
         SET name = coalesce(?, name),
             provider = coalesce(?, provider),
             type = coalesce(?, type),
             policy_number = coalesce(?, policy_number),
             premium_amount = coalesce(?, premium_amount),
             premium_frequency = coalesce(?, premium_frequency),
             coverage_amount = coalesce(?, coverage_amount),
             start_date = coalesce(?, start_date),
             end_date = coalesce(?, end_date),
             renewal_date = coalesce(?, renewal_date),
             notes = coalesce(?, notes),
             terms = coalesce(?, terms),
             covered_conditions = coalesce(?, covered_conditions),
             insured_name = coalesce(?, insured_name),
             fund_value = coalesce(?, fund_value),
             updated_at = datetime('now')
         WHERE id = ?`
      ).run(
        name ? String(name) : null,
        provider ? String(provider) : null,
        type ? String(type) : null,
        policy_number ? String(policy_number) : null,
        premium_amount != null ? Number(premium_amount) : null,
        premium_frequency ? String(premium_frequency) : null,
        coverage_amount != null ? Number(coverage_amount) : null,
        start_date ? String(start_date) : null,
        end_date ? String(end_date) : null,
        renewal_date ? String(renewal_date) : null,
        notes ? String(notes) : null,
        terms ? String(terms) : null,
        covered_conditions != null ? JSON.stringify(Array.isArray(covered_conditions) ? covered_conditions : []) : null,
        insured_name ? String(insured_name) : null,
        fund_value != null ? Number(fund_value) : null,
        existingId
      );
      // Record the new premium in history so the graph reflects the updated value
      conn.prepare(
        `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes)
         VALUES ('insurance', ?, ?, date('now'), 'import update')`
      ).run(existingId, newPremium);
      // Sync or auto-create the linked brokerage account when fund_value is present
      if (fund_value != null && Number(fund_value) > 0) {
        const linkedPlan = conn.prepare(`SELECT linked_account_id, name as pname, provider as pprovider FROM insurance_plans WHERE id = ?`).get(existingId);
        if (linkedPlan) {
          if (linkedPlan.linked_account_id) {
            // Already linked — just sync the balance.
            conn.prepare(`UPDATE accounts SET balance=?, updated_at=datetime('now') WHERE id=?`)
              .run(Number(fund_value), linkedPlan.linked_account_id);
            conn.prepare(
              `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes)
               VALUES ('account', ?, ?, date('now'), 'insurance fund value update')`
            ).run(linkedPlan.linked_account_id, Number(fund_value));
          } else {
            // No linked account yet — create one now and link it.
            const effectiveName = (name && String(name).trim()) || (linkedPlan.pname && String(linkedPlan.pname).trim()) || 'Insurance';
            const effectiveProvider = (provider && String(provider).trim()) || (linkedPlan.pprovider && String(linkedPlan.pprovider).trim()) || null;
            const accountName = `${effectiveName} – Fund`;
            const existingAcc = conn.prepare(`SELECT id FROM accounts WHERE lower(name)=lower(?)`).get(accountName);
            if (!existingAcc) {
              const currency = getDefaultCurrency(conn) || 'USD';
              const accResult = conn.prepare(
                `INSERT INTO accounts (name, institution, type, currency, balance) VALUES (?, ?, 'brokerage', ?, ?)`
              ).run(accountName, effectiveProvider, currency, Number(fund_value));
              conn.prepare(
                `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes)
                 VALUES ('account', ?, ?, date('now'), 'Initial value from insurance fund')`
              ).run(accResult.lastInsertRowid, Number(fund_value));
              conn.prepare(
                `UPDATE insurance_plans SET linked_account_id=? WHERE id=?`
              ).run(accResult.lastInsertRowid, existingId);
            }
          }
        }
      }
    }
  });
  doUpdate();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB (PDFs can be larger than CSVs)
});

/**
 * POST /api/import/csv
 * Expected CSV columns (case-insensitive):
 *   For accounts balance import:
 *     name, institution, type, currency, balance
 *   For assets:
 *     name, category, acquisition_date, acquisition_cost, current_value
 *   For liabilities:
 *     name, lender, type, original_principal, current_balance, interest_rate, minimum_payment
 *
 * The import_type query param determines which table to import into:
 *   ?import_type=accounts  (default)
 *   ?import_type=assets
 *   ?import_type=liabilities
 *
 * NOTE: This route always skips duplicates. For 3-way duplicate handling
 * (skip / update existing / create new) use POST /csv/preview first to
 * get a preview, then confirm with POST /json (which honours _updateExisting
 * and _forceImport flags on individual records).
 */
const VALID_IMPORT_TYPES = ['accounts', 'assets', 'liabilities', 'insurance'];

router.post('/csv', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const importType = req.query.import_type || 'accounts';
  if (!VALID_IMPORT_TYPES.includes(importType)) {
    return res.status(400).json({ error: `import_type must be one of: ${VALID_IMPORT_TYPES.join(', ')}` });
  }

  let records;
  try {
    records = parse(req.file.buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      cast: true,
    });
  } catch (err) {
    return res.status(422).json({ error: `CSV parse error: ${err.message}` });
  }

  if (records.length === 0) {
    return res.status(422).json({ error: 'CSV file is empty or has no data rows' });
  }

  const conn = db.getDb();
  const defaultCurrency = getDefaultCurrency(conn);
  const results = { imported: 0, skipped: 0, duplicates: 0, errors: [] };

  const normalizeKeys = (obj) => applyColumnAliases(
    Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase().replace(/\s+/g, '_'), v])),
    importType
  );

  const isDuplicate = (row) => isDuplicateRecord(conn, importType, row);

  const importRow = conn.transaction((record) => {
    const row = normalizeKeys(record);

    if (isDuplicate(row)) throw new DuplicateError('Duplicate entry skipped');

    if (importType === 'accounts') {
      const { name, institution, type = 'other', currency = defaultCurrency, balance = 0 } = row;
      if (!name) throw new Error('name is required');
      const newBalance = Number(balance);
      const insResult = conn.prepare(
        `INSERT INTO accounts (name, institution, type, currency, balance)
         VALUES (?, ?, ?, COALESCE(?, 'USD'), ?)`
      ).run(String(name), institution ? String(institution) : null, String(type), currency || null, newBalance);
      conn.prepare(
        `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes)
         VALUES ('account', ?, ?, date('now'), 'import')`
      ).run(insResult.lastInsertRowid, newBalance);

    } else if (importType === 'assets') {
      const { name, category = 'other', acquisition_date, acquisition_cost, current_value = 0 } = row;
      if (!name) throw new Error('name is required');
      const newValue = Number(current_value);
      const insResult = conn.prepare(
        `INSERT INTO assets (name, category, acquisition_date, acquisition_cost, current_value)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        String(name), String(category),
        acquisition_date ? String(acquisition_date) : null,
        acquisition_cost != null ? Number(acquisition_cost) : null,
        newValue
      );
      conn.prepare(
        `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes)
         VALUES ('asset', ?, ?, date('now'), 'import')`
      ).run(insResult.lastInsertRowid, newValue);

    } else if (importType === 'liabilities') {
      const { name, lender, type = 'other', original_principal, current_balance = 0, interest_rate, minimum_payment } = row;
      if (!name) throw new Error('name is required');
      const newBalance = Number(current_balance);
      const insResult = conn.prepare(
        `INSERT INTO liabilities (name, lender, type, original_principal, current_balance, interest_rate, minimum_payment)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        String(name), lender ? String(lender) : null, String(type),
        original_principal != null ? Number(original_principal) : null,
        newBalance,
        interest_rate != null ? Number(interest_rate) : null,
        minimum_payment != null ? Number(minimum_payment) : null
      );
      conn.prepare(
        `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes)
         VALUES ('liability', ?, ?, date('now'), 'import')`
      ).run(insResult.lastInsertRowid, newBalance);

    } else if (importType === 'insurance') {
      const { name, provider, type = 'other', policy_number, premium_amount, premium_frequency = 'monthly', coverage_amount, start_date, end_date, renewal_date, notes, terms, covered_conditions, insured_name, fund_value } = row;
      if (!name) throw new Error('name is required');
      const covJson = covered_conditions != null
        ? JSON.stringify(Array.isArray(covered_conditions) ? covered_conditions : [])
        : null;
      const insResult = conn.prepare(
        `INSERT INTO insurance_plans (name, provider, type, policy_number, premium_amount, premium_frequency, coverage_amount, start_date, end_date, renewal_date, notes, terms, covered_conditions, insured_name, fund_value)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        String(name), provider ? String(provider) : null, String(type),
        policy_number ? String(policy_number) : null,
        premium_amount != null ? Number(premium_amount) : null,
        String(premium_frequency),
        coverage_amount != null ? Number(coverage_amount) : null,
        start_date ? String(start_date) : null,
        end_date ? String(end_date) : null,
        renewal_date ? String(renewal_date) : null,
        notes ? String(notes) : null,
        terms ? String(terms) : null,
        covJson,
        insured_name ? String(insured_name) : null,
        fund_value != null ? Number(fund_value) : null
      );
      const planId = insResult.lastInsertRowid;
      conn.prepare(
        `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes)
         VALUES ('insurance', ?, ?, date('now'), 'import')`
      ).run(planId, premium_amount != null ? Number(premium_amount) : 0);

      // Auto-create a linked brokerage account for the fund value so it is
      // immediately visible in net worth without any extra manual step.
      if (fund_value != null && Number(fund_value) > 0) {
        const accountName = `${String(name)} – Fund`;
        const existingAcc = conn.prepare(`SELECT id FROM accounts WHERE lower(name)=lower(?)`).get(accountName);
        if (!existingAcc) {
          const currency = getDefaultCurrency(conn) || 'USD';
          const accResult = conn.prepare(
            `INSERT INTO accounts (name, institution, type, currency, balance) VALUES (?, ?, 'brokerage', ?, ?)`
          ).run(accountName, provider ? String(provider) : null, currency, Number(fund_value));
          conn.prepare(
            `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes)
             VALUES ('account', ?, ?, date('now'), 'Initial value from insurance fund')`
          ).run(accResult.lastInsertRowid, Number(fund_value));
          conn.prepare(
            `UPDATE insurance_plans SET linked_account_id=? WHERE id=?`
          ).run(accResult.lastInsertRowid, planId);
        }
      }

    }
  });  // end conn.transaction

  for (let i = 0; i < records.length; i++) {
    try {
      importRow(records[i]);
      results.imported++;
    } catch (err) {
      results.skipped++;
      if (err instanceof DuplicateError) {
        results.duplicates++;
      } else {
        results.errors.push({ row: i + 2, message: err.message });
      }
    }
  }

  res.json(results);
});

/**
 * POST /api/import/csv/preview
 * Upload a CSV file, use AI to intelligently map column headers to target schema fields,
 * and return a preview of the mapped records WITHOUT writing to the database.
 *
 * Query params: ?import_type=accounts|assets|liabilities|insurance  (default: accounts)
 *
 * When AI is unavailable, falls back to basic lowercase+underscore key normalization.
 */
router.post('/csv/preview', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const importType = req.query.import_type || 'accounts';
  if (!VALID_IMPORT_TYPES.includes(importType)) {
    return res.status(400).json({ error: `import_type must be one of: ${VALID_IMPORT_TYPES.join(', ')}` });
  }

  let records;
  try {
    records = parse(req.file.buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      cast: true,
    });
  } catch (err) {
    return res.status(422).json({ error: `CSV parse error: ${err.message}` });
  }

  if (records.length === 0) {
    return res.status(422).json({ error: 'CSV file is empty or has no data rows' });
  }

  const headers = Object.keys(records[0]);
  const sampleRows = records.slice(0, 3);

  let mappedRecords;
  let method;
  let validationNotes = [];

  try {
    const aiResult = await mapCsvColumnsWithAI(headers, sampleRows, importType);
    if (aiResult && aiResult.column_mapping) {
      // Apply the AI column mapping to every row
      mappedRecords = records.map((row) => {
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
    // AI mapping failed or unavailable — fall back to basic key normalization (same as /csv route)
    if (aiErr.message !== 'AI unavailable') {
      console.error('CSV AI column mapping failed, falling back to key normalization:', aiErr.message);
    }
    mappedRecords = records.map((row) => {
      const normalized = Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k.toLowerCase().replace(/\s+/g, '_'), v])
      );
      return applyColumnAliases(normalized, importType);
    });
    method = 'pattern';
  }

  res.json({ import_type: importType, records: mappedRecords, method, validation_notes: validationNotes });
});


router.post('/json', express.json({ limit: '10mb' }), (req, res) => {
  const { import_type: importType = 'accounts', records } = req.body || {};

  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: 'records must be a non-empty array' });
  }

  if (!VALID_IMPORT_TYPES.includes(importType)) {
    return res.status(400).json({ error: `import_type must be one of: ${VALID_IMPORT_TYPES.join(', ')}` });
  }

  const conn = db.getDb();
  const defaultCurrency = getDefaultCurrency(conn);
  const results = { imported: 0, updated: 0, skipped: 0, duplicates: 0, errors: [] };

  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    try {
      const existing = getExistingRecord(conn, importType, row);
      if (existing) {
        if (row._updateExisting) {
          updateExistingRecord(conn, importType, row, existing.id, existing.value, defaultCurrency);
          results.updated++;
          continue;
        }
        if (!row._forceImport) { results.skipped++; results.duplicates++; continue; }
      }

      if (importType === 'accounts') {
        const { name, institution, type = 'other', currency = defaultCurrency, balance = 0 } = row;
        if (!name) throw new Error('name is required');
        const newBalance = Number(balance);
        const insResult = conn.prepare(
          `INSERT INTO accounts (name, institution, type, currency, balance) VALUES (?, ?, ?, COALESCE(?, 'USD'), ?)`
        ).run(String(name), institution ? String(institution) : null, String(type), currency || null, newBalance);
        conn.prepare(
          `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes)
           VALUES ('account', ?, ?, date('now'), 'import')`
        ).run(insResult.lastInsertRowid, newBalance);

      } else if (importType === 'assets') {
        const { name, category = 'other', acquisition_date, acquisition_cost, current_value = 0 } = row;
        if (!name) throw new Error('name is required');
        const newValue = Number(current_value);
        const insResult = conn.prepare(
          `INSERT INTO assets (name, category, acquisition_date, acquisition_cost, current_value) VALUES (?, ?, ?, ?, ?)`
        ).run(
          String(name), String(category),
          acquisition_date ? String(acquisition_date) : null,
          acquisition_cost != null ? Number(acquisition_cost) : null,
          newValue
        );
        conn.prepare(
          `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes)
           VALUES ('asset', ?, ?, date('now'), 'import')`
        ).run(insResult.lastInsertRowid, newValue);

      } else if (importType === 'liabilities') {
        const { name, lender, type = 'other', original_principal, current_balance = 0, interest_rate, minimum_payment } = row;
        if (!name) throw new Error('name is required');
        const newBalance = Number(current_balance);
        const insResult = conn.prepare(
          `INSERT INTO liabilities (name, lender, type, original_principal, current_balance, interest_rate, minimum_payment) VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          String(name), lender ? String(lender) : null, String(type),
          original_principal != null ? Number(original_principal) : null,
          newBalance,
          interest_rate != null ? Number(interest_rate) : null,
          minimum_payment != null ? Number(minimum_payment) : null
        );
        conn.prepare(
          `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes)
           VALUES ('liability', ?, ?, date('now'), 'import')`
        ).run(insResult.lastInsertRowid, newBalance);

      } else if (importType === 'insurance') {
        const { name, provider, type = 'other', policy_number, premium_amount, premium_frequency = 'monthly', coverage_amount, start_date, end_date, renewal_date, notes, terms, covered_conditions, insured_name, fund_value } = row;
        if (!name) throw new Error('name is required');
        const covJson = covered_conditions != null
          ? JSON.stringify(Array.isArray(covered_conditions) ? covered_conditions : [])
          : null;
        const insResult = conn.prepare(
          `INSERT INTO insurance_plans (name, provider, type, policy_number, premium_amount, premium_frequency, coverage_amount, start_date, end_date, renewal_date, notes, terms, covered_conditions, insured_name, fund_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          String(name), provider ? String(provider) : null, String(type),
          policy_number ? String(policy_number) : null,
          premium_amount != null ? Number(premium_amount) : null,
          String(premium_frequency),
          coverage_amount != null ? Number(coverage_amount) : null,
          start_date ? String(start_date) : null,
          end_date ? String(end_date) : null,
          renewal_date ? String(renewal_date) : null,
          notes ? String(notes) : null,
          terms ? String(terms) : null,
          covJson,
          insured_name ? String(insured_name) : null,
          fund_value != null ? Number(fund_value) : null
        );
        const planId = insResult.lastInsertRowid;
        conn.prepare(
          `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes)
           VALUES ('insurance', ?, ?, date('now'), 'import')`
        ).run(planId, premium_amount != null ? Number(premium_amount) : 0);

        // Auto-create a linked brokerage account so the fund value is
        // immediately visible in net worth without any extra manual step.
        if (fund_value != null && Number(fund_value) > 0) {
          const accountName = `${String(name)} – Fund`;
          const existingAcc = conn.prepare(`SELECT id FROM accounts WHERE lower(name)=lower(?)`).get(accountName);
          if (!existingAcc) {
            const currency = getDefaultCurrency(conn) || 'USD';
            const accResult = conn.prepare(
              `INSERT INTO accounts (name, institution, type, currency, balance) VALUES (?, ?, 'brokerage', ?, ?)`
            ).run(accountName, provider ? String(provider) : null, currency, Number(fund_value));
            conn.prepare(
              `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes)
               VALUES ('account', ?, ?, date('now'), 'Initial value from insurance fund')`
            ).run(accResult.lastInsertRowid, Number(fund_value));
            conn.prepare(
              `UPDATE insurance_plans SET linked_account_id=? WHERE id=?`
            ).run(accResult.lastInsertRowid, planId);
          }
        }
      }
      results.imported++;
    } catch (err) {
      results.skipped++;
      results.errors.push({ row: i + 1, message: err.message });
    }
  }

  res.json(results);
});


/**
 * POST /api/import/check-duplicates
 * Body: { import_type, records }
 * Returns:
 *   duplicates  – indices of records that already exist in the DB.
 *   withinBatch – indices of records that are duplicates of an earlier row in the same
 *                 batch (in-file duplicates, e.g. a summary and a detail line for the
 *                 same account in a single statement).
 */
router.post('/check-duplicates', express.json({ limit: '1mb' }), (req, res) => {
  const { import_type: importType, records } = req.body || {};
  if (!VALID_IMPORT_TYPES.includes(importType)) {
    return res.status(400).json({ error: `import_type must be one of: ${VALID_IMPORT_TYPES.join(', ')}` });
  }
  if (!Array.isArray(records)) {
    return res.status(400).json({ error: 'records must be an array' });
  }
  const conn = db.getDb();
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
    if (isDuplicateRecord(conn, importType, records[i])) {
      duplicates.push(i);
    }
  }
  res.json({ duplicates, withinBatch });
});

/**
 * Returns an error response if the uploaded file is not a PDF, otherwise null.
 * Checks both the MIME type (when provided by the browser) and the file extension.
 */
function validatePdfFile(req, res) {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded' });
    return false;
  }
  if (
    req.file.mimetype &&
    !req.file.mimetype.includes('pdf') &&
    !req.file.originalname?.toLowerCase().endsWith('.pdf')
  ) {
    res.status(422).json({ error: 'File must be a PDF' });
    return false;
  }
  return true;
}

/**
 * POST /api/import/pdf/preview
 * Upload a PDF statement (optionally password-protected), extract text,
 * and run the smart parser + optional AI parser.  Returns a preview of
 * what would be imported WITHOUT writing to the database.
 *
 * Form fields:
 *   file        – PDF file (required)
 *   password    – PDF password (optional)
 */
router.post('/pdf/preview', upload.single('file'), async (req, res) => {
  if (!validatePdfFile(req, res)) return;

  try {
    const text = await extractPdfText(req.file.buffer, req.body.password || '');
    if (!text.trim()) {
      return res.status(422).json({ error: 'Could not extract text from PDF. The file may be scanned/image-only.' });
    }

    const conn = db.getDb();
    const result = await parseStatement(text, { defaultCurrency: getDefaultCurrency(conn) });
    res.json(result);
  } catch (err) {
    if (err.code === 'PASSWORD_REQUIRED') {
      return res.status(422).json({ error: err.message, code: 'PASSWORD_REQUIRED' });
    }
    console.error('PDF preview error:', err);
    res.status(500).json({ error: `Failed to parse PDF: ${err.message}` });
  }
});

/**
 * POST /api/import/pdf
 * Parse and immediately import a PDF statement into the database.
 * Accepts same fields as /pdf/preview, plus:
 *   import_type       – optional override ('accounts'|'assets'|'liabilities'|'insurance')
 *   previewed_records – optional JSON string of pre-parsed records from /pdf/preview.
 *                       When provided the PDF is not re-parsed, preventing drift between
 *                       what the user reviewed and what is actually written to the DB.
 */
router.post('/pdf', upload.single('file'), async (req, res) => {
  if (!validatePdfFile(req, res)) return;

  try {
    let parsed;

    // If the client supplies pre-parsed records (from the /pdf/preview step) use them
    // directly so the user always gets exactly what they reviewed imported into the DB.
    if (req.body.previewed_records) {
      if (!req.body.import_type) {
        return res.status(400).json({ error: 'import_type is required when previewed_records is provided' });
      }
      let previewedRecords;
      try {
        previewedRecords = JSON.parse(req.body.previewed_records);
      } catch {
        return res.status(400).json({ error: 'previewed_records must be a valid JSON array string' });
      }
      if (!Array.isArray(previewedRecords)) {
        return res.status(400).json({ error: 'previewed_records must be a JSON array' });
      }
      parsed = {
        import_type: req.body.import_type,
        records: previewedRecords,
        method: 'preview',
      };
    } else {
      // Re-parse from the PDF (legacy path / direct API calls without a prior preview)
      const text = await extractPdfText(req.file.buffer, req.body.password || '');
      if (!text.trim()) {
        return res.status(422).json({ error: 'Could not extract text from PDF.' });
      }
      const conn2 = db.getDb();
      parsed = await parseStatement(text, { defaultCurrency: getDefaultCurrency(conn2) });
    }

    // Allow caller to override the detected import type
    const importType = req.body.import_type || parsed.import_type;
    if (!VALID_IMPORT_TYPES.includes(importType)) {
      return res.status(400).json({ error: `import_type must be one of: ${VALID_IMPORT_TYPES.join(', ')}` });
    }

    const conn = db.getDb();
    const defaultCurrency = getDefaultCurrency(conn);
    const results = { imported: 0, updated: 0, skipped: 0, duplicates: 0, errors: [], method: parsed.method };

    for (let i = 0; i < parsed.records.length; i++) {
      const row = parsed.records[i];
      try {
        const existing = getExistingRecord(conn, importType, row);
        if (existing) {
          if (row._updateExisting) {
            updateExistingRecord(conn, importType, row, existing.id, existing.value, defaultCurrency);
            results.updated++;
            continue;
          }
          if (!row._forceImport) { results.skipped++; results.duplicates++; continue; }
        }

        if (importType === 'accounts') {
          const { name, institution, type = 'other', currency = defaultCurrency, balance = 0 } = row;
          if (!name) throw new Error('name is required');
          conn.prepare(
            `INSERT INTO accounts (name, institution, type, currency, balance) VALUES (?, ?, ?, COALESCE(?, 'USD'), ?)`
          ).run(String(name), institution ? String(institution) : null, String(type), currency || null, Number(balance));
        } else if (importType === 'assets') {
          const { name, category = 'other', acquisition_date, acquisition_cost, current_value = 0 } = row;
          if (!name) throw new Error('name is required');
          conn.prepare(
            `INSERT INTO assets (name, category, acquisition_date, acquisition_cost, current_value) VALUES (?, ?, ?, ?, ?)`
          ).run(
            String(name), String(category),
            acquisition_date ? String(acquisition_date) : null,
            acquisition_cost != null ? Number(acquisition_cost) : null,
            Number(current_value)
          );
        } else if (importType === 'liabilities') {
          const { name, lender, type = 'other', original_principal, current_balance = 0, interest_rate, minimum_payment } = row;
          if (!name) throw new Error('name is required');
          conn.prepare(
            `INSERT INTO liabilities (name, lender, type, original_principal, current_balance, interest_rate, minimum_payment) VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run(
            String(name), lender ? String(lender) : null, String(type),
            original_principal != null ? Number(original_principal) : null,
            Number(current_balance),
            interest_rate != null ? Number(interest_rate) : null,
            minimum_payment != null ? Number(minimum_payment) : null
          );
        } else if (importType === 'insurance') {
          const { name, provider, type = 'other', policy_number, premium_amount, premium_frequency = 'monthly', coverage_amount, start_date, end_date, renewal_date, notes, terms, covered_conditions, insured_name, fund_value } = row;
          if (!name) throw new Error('name is required');
          const covJson = covered_conditions != null
            ? JSON.stringify(Array.isArray(covered_conditions) ? covered_conditions : [])
            : null;
          const insResult = conn.prepare(
            `INSERT INTO insurance_plans (name, provider, type, policy_number, premium_amount, premium_frequency, coverage_amount, start_date, end_date, renewal_date, notes, terms, covered_conditions, insured_name, fund_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            String(name), provider ? String(provider) : null, String(type),
            policy_number ? String(policy_number) : null,
            premium_amount != null ? Number(premium_amount) : null,
            String(premium_frequency),
            coverage_amount != null ? Number(coverage_amount) : null,
            start_date ? String(start_date) : null,
            end_date ? String(end_date) : null,
            renewal_date ? String(renewal_date) : null,
            notes ? String(notes) : null,
            terms ? String(terms) : null,
            covJson,
            insured_name ? String(insured_name) : null,
            fund_value != null ? Number(fund_value) : null
          );
          const planId = insResult.lastInsertRowid;
          conn.prepare(
            `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes)
             VALUES ('insurance', ?, ?, date('now'), 'import')`
          ).run(planId, premium_amount != null ? Number(premium_amount) : 0);

          // Auto-create a linked brokerage account so the fund value is
          // immediately visible in net worth without any extra manual step.
          if (fund_value != null && Number(fund_value) > 0) {
            const accountName = `${String(name)} – Fund`;
            const existingAcc = conn.prepare(`SELECT id FROM accounts WHERE lower(name)=lower(?)`).get(accountName);
            if (!existingAcc) {
              const accResult = conn.prepare(
                `INSERT INTO accounts (name, institution, type, currency, balance) VALUES (?, ?, 'brokerage', ?, ?)`
              ).run(accountName, provider ? String(provider) : null, defaultCurrency || 'USD', Number(fund_value));
              conn.prepare(
                `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes)
                 VALUES ('account', ?, ?, date('now'), 'Initial value from insurance fund')`
              ).run(accResult.lastInsertRowid, Number(fund_value));
              conn.prepare(
                `UPDATE insurance_plans SET linked_account_id=? WHERE id=?`
              ).run(accResult.lastInsertRowid, planId);
            }
          }
        }
        results.imported++;
      } catch (err) {
        results.skipped++;
        results.errors.push({ row: i + 1, message: err.message });
      }
    }

    res.json(results);
  } catch (err) {
    if (err.code === 'PASSWORD_REQUIRED') {
      return res.status(422).json({ error: err.message, code: 'PASSWORD_REQUIRED' });
    }
    console.error('PDF import error:', err);
    res.status(500).json({ error: `Failed to import PDF: ${err.message}` });
  }
});

/**
 * POST /api/import/text
 * Parse raw text (pasted by the user) using AI and return a preview.
 * Body: { text: string, import_type?: string }
 * Returns same shape as /pdf/preview.
 */
router.post('/text', express.json({ limit: '2mb' }), async (req, res) => {
  const { text, import_type: hintType } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required and must be a non-empty string' });
  }

  try {
    const options = hintType ? { hintType } : {};
    const result = await parseStatement(text.trim(), options);
    res.json(result);
  } catch (err) {
    console.error('Text import error:', err);
    res.status(500).json({ error: `Failed to parse text: ${err.message}` });
  }
});

module.exports = router;
